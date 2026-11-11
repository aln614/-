'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {APIMART_IMAGE_MODELS, getApimartImageRule, sanitizeApimartImagePayload, generateOne} = require('../src/services/apiClient');
const {createFallbackPricingCatalog, createLivePricingCatalog} = require('../src/services/apimartPricing');

const model = 'seedream-5-5';
assert.ok(APIMART_IMAGE_MODELS.includes(model));
const rule = getApimartImageRule(model);
assert.equal(rule.maxImageUrls,10);
assert.equal(rule.maxImageBytes,30 * 1024 * 1024);
assert.deepEqual(rule.resolutions,['1K','1.5K','2K','auto']);

const defaultPayload = sanitizeApimartImagePayload({prompt:'test'},model);
assert.equal(defaultPayload.model,model);
assert.equal(defaultPayload.n,1);
assert.equal(defaultPayload.resolution,'2K');
assert.equal(defaultPayload.output_format,'png');
assert.deepEqual(defaultPayload.optimize_prompt_options,{mode:'standard'});

const ratioPayload = sanitizeApimartImagePayload({size:'16:9',resolution:'1.5K',output_format:'jpeg'},model);
assert.equal(ratioPayload.size,'16:9');
assert.equal(ratioPayload.resolution,'1.5K');
assert.equal(ratioPayload.output_format,'jpeg');

const tierPayload = sanitizeApimartImagePayload({size:'1.5K',resolution:'2K'},model);
assert.equal(tierPayload.size,'1.5K');
assert.ok(!('resolution' in tierPayload));
const customPayload = sanitizeApimartImagePayload({size:'2048x1024',resolution:'1K'},model);
assert.equal(customPayload.size,'2048x1024');
assert.ok(!('resolution' in customPayload));
assert.equal(sanitizeApimartImagePayload({size:'512x512'},model).size,'auto');
assert.equal(sanitizeApimartImagePayload({size:'1:8'},model).size,'auto');

const refs = Array.from({length:11},(_,index)=>`https://example.com/${index}.png`);
assert.equal(sanitizeApimartImagePayload({image_urls:refs.slice(0,10)},model).image_urls.length,10);
assert.throws(()=>sanitizeApimartImagePayload({image_urls:refs},model),/10/);
const transparent = sanitizeApimartImagePayload({background:'transparent',output_format:'jpeg'},model);
assert.equal(transparent.background,'transparent');
assert.equal(transparent.output_format,'png');

const fallback = createFallbackPricingCatalog().models[model];
assert.equal(fallback.variants.find(item=>item.spec==='1K').credits,0.13);
assert.equal(fallback.variants.find(item=>item.spec==='1.5K').credits,0.13);
assert.equal(fallback.variants.find(item=>item.spec==='2K').credits,0.2275);
assert.equal(fallback.referenceImageCredits,0.052);

const demoRows = Array.from({length:16},(_,index)=>`<h3 title="demo-${index}">demo-${index}</h3><table><tbody><tr><th scope="row" title="default">default</th><td>1 Credits/张</td></tr></tbody></table>`).join('');
const seedreamRows = ['default:0.2275','1K:0.13','1K-layer:0.13','2K:0.2275','2K-layer:0.2275'].map(item=>{
  const [spec,price] = item.split(':');
  return `<tr><th scope="row" title="${spec}">${spec}</th><td>${price} Credits/张</td></tr>`;
}).join('');
const live = createLivePricingCatalog(`${demoRows}<h3 title="${model}">${model}</h3><table><tbody>${seedreamRows}</tbody></table>`).models[model];
assert.equal(live.variants.find(item=>item.spec==='1.5K').credits,0.13);
assert.equal(live.referenceImageCredits,0.052);

async function verifySubmission() {
  const file = path.join(__dirname,'../src/services/apiClient.js');
  const source = fs.readFileSync(file,'utf8');
  const submitted = [];
  const context = vm.createContext({require:createRequire(file),module:{exports:{}},process,Buffer,URL,AbortController,setTimeout,clearTimeout,setImmediate,console});
  vm.runInContext(source+`\nmodule.exports.__mockTransport = hooks => {
    uploadImageToApimart = hooks.upload;
    postJson = hooks.post;
    downloadResultToFile = hooks.download;
  };`,context);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'seedream55-submit-'));
  try {
    const reference = path.join(temporary,'reference.png');
    const output = path.join(temporary,'result.png');
    fs.writeFileSync(reference,'reference');
    context.module.exports.__mockTransport({
      upload:async()=> 'https://example.com/reference.png',
      post:async(_url,_key,payload)=>{submitted.push(JSON.parse(JSON.stringify(payload)));return {data:[{url:['https://example.com/result.png']}]};},
      download:async(_url,target)=>fs.promises.writeFile(target,'mock')
    });
    await context.module.exports.generateOne({
      cfg:{model,size:'1.5K',imageSize:'2K',outputFormat:'jpeg',background:'transparent',apiKey:'mock'},
      prompt:'test',mainImagePath:reference,outputPath:output
    });
    assert.equal(submitted.length,1);
    assert.equal(submitted[0].model,model);
    assert.equal(submitted[0].size,'1.5K');
    assert.ok(!('resolution' in submitted[0]));
    assert.equal(submitted[0].output_format,'png');
    assert.equal(submitted[0].background,'transparent');
    assert.deepEqual(submitted[0].optimize_prompt_options,{mode:'standard'});
    assert.deepEqual(submitted[0].image_urls,['https://example.com/reference.png']);
    assert.equal(fs.readFileSync(output,'utf8'),'mock');
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}

verifySubmission().then(()=>console.log('Seedream 5.5 model checks passed: catalog, payload limits, transparency, live/fallback pricing and mocked submission.'))
  .catch(error=>{console.error(error);process.exitCode=1;});
