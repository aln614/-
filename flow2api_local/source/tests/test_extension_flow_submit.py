import asyncio
import json
import unittest

from src.services.browser_captcha_extension import ExtensionCaptchaService, ExtensionConnection


class _FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send_text(self, data):
        self.messages.append(json.loads(data))


class ExtensionFlowSubmitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.websocket = _FakeWebSocket()
        self.service = ExtensionCaptchaService()
        self.service.active_connections.append(ExtensionConnection(self.websocket))

    async def test_token_tab_is_reused_for_flow_submit(self):
        token_task = asyncio.create_task(
            self.service.get_token("project-1", token_id=None, timeout=2)
        )
        await asyncio.sleep(0)
        token_request = self.websocket.messages[-1]
        await self.service.handle_message(
            self.websocket,
            json.dumps({
                "req_id": token_request["req_id"],
                "status": "success",
                "token": "captcha-token",
                "tab_id": 321,
            }),
        )
        self.assertEqual(await token_task, "captcha-token")

        submit_task = asyncio.create_task(
            self.service.request_flow_api(
                url="https://example.invalid/projects/project-1/flowMedia:batchGenerateImages",
                json_data={"requests": []},
                at_token="access-token",
                timeout=2,
            )
        )
        await asyncio.sleep(0)
        submit_request = self.websocket.messages[-1]
        self.assertEqual(submit_request["type"], "submit_flow")
        self.assertEqual(submit_request["tab_id"], 321)
        await self.service.handle_message(
            self.websocket,
            json.dumps({
                "req_id": submit_request["req_id"],
                "status": "success",
                "result": {
                    "ok": True,
                    "status": 200,
                    "text": json.dumps({"media": [{"name": "image-1"}]}),
                },
            }),
        )
        self.assertEqual((await submit_task)["media"][0]["name"], "image-1")


if __name__ == "__main__":
    unittest.main()
