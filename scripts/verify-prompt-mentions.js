const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {compile, activeQuery, tokens} = require('../src/renderer/static/prompt-mention-core');
const {initDB} = require('../src/services/db');
const {TaskQueue} = require('../src/services/taskQueue');

const refs = ['person.png', 'room.png'];
const mentions = [{token:'@图1', kind:'ref', index:0}, {token:'@图2', kind:'ref', index:1}];
assert.deepEqual(tokens('@图1 @图10 @图1'), ['@图1','@图10']);
assert.deepEqual(tokens('@Image1 @Image10 @Image1 @Image1abc'), ['@Image1','@Image10']);
const englishMentions = [{token:'@Image1', kind:'current_main', index:0}, {token:'@Image2', kind:'ref', index:0}];
for(const main of ['main-a.png','main-b.png','main-c.png']){
  const resolved = compile('Put @Image1 in @Image2', englishMentions, ['main-a.png','main-b.png','main-c.png'], refs, main);
  assert.equal(resolved.prompt, 'Put Image 1 in Image 2');
  assert.deepEqual(resolved.refImages, refs, 'Each task must receive only its main image and shared references');
}
assert.throws(() => compile('@Image1', englishMentions, [], refs), /主任务图片已移除/);
assert.equal(compile('@Image1 @Image2', [{token:'@Image1',kind:'ref',index:0},{token:'@Image2',kind:'ref',index:1}], [], refs).prompt, 'Image 1 Image 2');
assert.equal(compile('将@图1放到@图2', mentions, [], refs).prompt, '将图1放到图2');
assert.equal(compile('@图2 @图1', mentions, ['main.png'], refs, 'main.png').prompt, '图3 图2');
assert.deepEqual(refs, ['person.png','room.png']);
assert.equal(compile('普通提示词', [], [], []).prompt, '普通提示词');
assert.throws(() => compile('@图1', [], [], refs), /引用无效/);
assert.throws(() => compile('@图1', [...mentions, mentions[0]], [], refs), /引用无效/);
assert.throws(() => compile('@图1', [{...mentions[0], index:-1}], [], refs), /引用无效/);
assert.throws(() => compile('@图1', [{...mentions[0], index:0.5}], [], refs), /引用无效/);
assert.throws(() => compile('@图1', mentions, [], []), /已移除/);
assert.deepEqual(activeQuery('把人物放入@美国', 8), {start:5,end:8,query:'美国'});
assert.equal(activeQuery('a@example.com', 13), null);
assert.equal(activeQuery('@图片 ', 4), null);
assert.equal(activeQuery('@图片', 3, 2), null);
assert.deepEqual(activeQuery('前@图片后', 4), {start:1,end:4,query:'图片'});

async function main(){
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-mentions-'));
  try{
    const db = initDB(temp);
    const queue = new TaskQueue();
    queue.runBatch = async () => {}; // Never submit paid generation requests.
    const payload = {outputDir:temp, model:'gpt-image-2', prompts:'@图1 与 @图3\n@图2', promptMultilineTasks:true,
      mainImages:['main-a.png','main-b.png'], refImages:refs, repeatCount:2,
      promptMentions:[...mentions, {token:'@图3', kind:'main', index:0}]};
    const batch = queue.createBatch(payload, {});
    const tasks = db._store.tasks.filter(row => row.batch_id === batch.id);
    assert.equal(tasks.length, 8);
    assert.equal(tasks[0].prompt, '图2 与 图1');
    assert.equal(tasks[4].prompt, '图2 与 图4');
    assert.deepEqual(JSON.parse(tasks[4].ref_images_json), [...refs,'main-a.png']);
    assert.equal(tasks[6].prompt, '图3');
    const saved = JSON.parse(db._store.batches[0].config_json);
    assert.equal(saved.prompts, payload.prompts);
    const before = db._store.tasks.length;
    assert.throws(() => queue.createBatch({...payload, model:'flux-kontext-pro', prompts:'@图5', refImages:['1','2','3','4'], promptMentions:[{token:'@图5',kind:'ref',index:3}]}, {}), /参考图|图片/);
    assert.equal(db._store.tasks.length, before, 'Invalid references must not create partial batches');
    assert.throws(() => queue.createBatch({...payload, prompts:'@图99'}, {}), /引用无效/);

    // Exercise the actual repeat handler; it must retain each task's image mapping.
    const mainSource = fs.readFileSync(path.join(__dirname,'../src/main.js'), 'utf8');
    const mapStart = mainSource.indexOf('function mapPayloadToQueue(');
    const mapper = {resolveBatchMediaUploadIds:ids => ids || [], dataUrlToFile:item => item.valid ? item.name : '', readConfig:() => ({}), toCamelConfig:value => value,
      parseBoolValue:value => value, resolveBatchImageModel:() => 'gpt-image-2'};
    vm.createContext(mapper);
    vm.runInContext(mainSource.slice(mapStart, mainSource.indexOf('\nasync function repeatBatch(', mapStart)), mapper);
    assert.throws(() => mapper.mapPayloadToQueue({prompt_mentions:mentions, reference_images:[{valid:false},{valid:true,name:'wrong-index.png'}]}, 'local'), /完整读取/);
    const mapped = mapper.mapPayloadToQueue({prompt_mentions:mentions, prompts:'@图2', reference_image_upload_ids:refs}, 'local');
    assert.equal(mapped.payload.promptMentions, mentions);
    assert.equal(mapped.payload.refImages[1], refs[1]);
    const start = mainSource.indexOf('async function repeatBatch(');
    const code = mainSource.slice(start, mainSource.indexOf('\nfunction deleteImages(', start));
    let repeated;
    const context = {getDB:() => db, readConfig:() => ({}), toCamelConfig:value => value,
      queue:{createBatch:body => {repeated = body; return body;}}};
    vm.createContext(context); vm.runInContext(code, context);
    await context.repeatBatch(batch.id, 'local', 'local');
    assert.equal(repeated.prompts, payload.prompts);
    assert.deepEqual([...repeated.mainImages], payload.mainImages);
    assert.deepEqual([...repeated.refImages], payload.refImages);
    assert.equal(compile('@图1 与 @图3', repeated.promptMentions, repeated.mainImages, repeated.refImages, repeated.mainImages[1]).prompt, tasks[4].prompt);
    const englishPayload = {...payload, prompts:'Put @Image1 in @Image2', mainImages:['main-a.png','main-b.png','main-c.png'], promptMentions:englishMentions};
    const englishBatch = queue.createBatch(englishPayload, {});
    const englishTasks = db._store.tasks.filter(row => row.batch_id === englishBatch.id);
    assert.equal(englishTasks.length, 6);
    englishTasks.forEach((task, index) => {
      assert.equal(task.main_image_path, englishPayload.mainImages[Math.floor(index / 2)]);
      assert.equal(task.prompt, 'Put Image 1 in Image 2');
      assert.deepEqual(JSON.parse(task.ref_images_json), refs);
    });
    await context.repeatBatch(englishBatch.id, 'local', 'local');
    assert.equal(repeated.promptMentions[0].kind, 'current_main');
    assert.equal(compile(repeated.prompts, repeated.promptMentions, repeated.mainImages, repeated.refImages, repeated.mainImages[2]).prompt, 'Put Image 1 in Image 2');
    await new Promise(resolve => setImmediate(resolve));
    db._flushSync();
    console.log('Prompt mentions: matching, image order, multi-main batches, model limits, missing references and repeat mapping passed (no paid requests).');
  }finally{
    const relative = path.relative(os.tmpdir(), temp);
    if(!relative.startsWith('tenying-mentions-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup');
    fs.rmSync(temp, {recursive:true, force:true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
