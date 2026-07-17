import unittest

from src.services.flow_client import FlowClient
from src.services.load_balancer import LoadBalancer


class _TokenManager:
    async def get_active_tokens(self):
        return []


class FlowRiskBackoffTests(unittest.IsolatedAsyncioTestCase):
    async def test_account_cooldown_is_short_and_can_be_cleared(self):
        balancer = LoadBalancer(_TokenManager())

        await balancer.cooldown_token(7, seconds=1, reason="test")
        remaining = await balancer._get_risk_cooldown_remaining(7)

        self.assertGreater(remaining, 0)
        self.assertLessEqual(remaining, 15)

        await balancer.clear_token_cooldown(7)
        self.assertEqual(await balancer._get_risk_cooldown_remaining(7), 0)

    async def test_global_pause_is_short_and_can_be_cleared(self):
        client = FlowClient(proxy_manager=None)

        await client._activate_flow_risk_pause(
            "PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed",
            seconds=1,
        )
        remaining, _ = await client._get_flow_risk_pause_state()

        self.assertGreater(remaining, 0)
        self.assertLessEqual(remaining, 15)

        await client._clear_flow_risk_pause()
        self.assertEqual(await client._get_flow_risk_pause_state(), (0, ""))


if __name__ == "__main__":
    unittest.main()
