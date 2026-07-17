import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import WebSocket

from ..core.logger import debug_logger


@dataclass
class ExtensionConnection:
    websocket: WebSocket
    route_key: str = ""
    client_label: str = ""
    connected_at: float = field(default_factory=time.time)


class ExtensionCaptchaService:
    _instance: Optional["ExtensionCaptchaService"] = None
    _lock = asyncio.Lock()

    def __init__(self, db=None):
        self.db = db
        self.active_connections: list[ExtensionConnection] = []
        self.pending_requests: dict[str, tuple[asyncio.Future, WebSocket]] = {}
        self.last_token_tabs: dict[str, int] = {}

    @classmethod
    async def get_instance(cls, db=None) -> "ExtensionCaptchaService":
        if cls._instance is None:
            async with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(db=db)
        elif db is not None and cls._instance.db is None:
            cls._instance.db = db
        return cls._instance

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        conn = ExtensionConnection(
            websocket=websocket,
            route_key=(websocket.query_params.get("route_key") or "").strip(),
            client_label=(websocket.query_params.get("client_label") or "").strip(),
        )
        self.active_connections.append(conn)
        debug_logger.log_info(
            f"[Extension Captcha] Client connected. Total: {len(self.active_connections)}, "
            f"route_key={conn.route_key or '-'}, label={conn.client_label or '-'}"
        )

    def disconnect(self, websocket: WebSocket):
        for conn in list(self.active_connections):
            if conn.websocket is websocket:
                self.active_connections.remove(conn)
                debug_logger.log_info(
                    f"[Extension Captcha] Client disconnected. Total: {len(self.active_connections)}, "
                    f"route_key={conn.route_key or '-'}, label={conn.client_label or '-'}"
                )
                return

    def _find_connection(self, websocket: WebSocket) -> Optional[ExtensionConnection]:
        for conn in self.active_connections:
            if conn.websocket is websocket:
                return conn
        return None

    def _select_connection(self, route_key: str) -> Optional[ExtensionConnection]:
        normalized_key = (route_key or "").strip()
        if normalized_key:
            for conn in self.active_connections:
                if conn.route_key == normalized_key:
                    return conn
            return None
        # Empty token routes are only allowed to use an empty extension route.
        # A keyed route such as "9223" belongs to a specific browser/account
        # and must never be borrowed by another token just because it is the
        # only extension online.
        for conn in self.active_connections:
            if not conn.route_key:
                return conn
        return None

    def _describe_routes(self) -> str:
        labels = []
        for conn in self.active_connections:
            label = conn.route_key or "(empty)"
            if conn.client_label:
                label = f"{label}:{conn.client_label}"
            labels.append(label)
        return ", ".join(labels)

    def describe_routes(self) -> str:
        return self._describe_routes()

    async def _send_ack(self, websocket: WebSocket, payload: Dict[str, Any]):
        try:
            await websocket.send_text(json.dumps(payload))
        except Exception:
            pass

    async def _resolve_route_key(self, token_id: Optional[int]) -> str:
        if not token_id or not self.db:
            return ""
        try:
            token = await self.db.get_token(token_id)
            if token and token.extension_route_key:
                return token.extension_route_key.strip()
        except Exception as e:
            debug_logger.log_warning(f"[Extension Captcha] Failed to resolve route key for token {token_id}: {e}")
        return ""

    async def _sync_session_token(self, payload: Dict[str, Any]):
        st = (payload.get("st") or "").strip()
        if not st:
            return {"ok": False, "error": "empty session token"}
        if not self.db:
            return {"ok": False, "error": "database not ready"}

        try:
            from .flow_client import FlowClient
            from .proxy_manager import ProxyManager

            proxy_manager = ProxyManager(self.db)
            flow_client = FlowClient(proxy_manager, db=self.db)
            result = await flow_client.st_to_at(st)
            if result.get("error"):
                return {"ok": False, "error": str(result.get("error"))}

            at = result.get("access_token")
            expires = result.get("expires")
            user_info = result.get("user") or {}
            email = (user_info.get("email") or "").strip()
            name = (user_info.get("name") or email.split("@")[0] if email else "").strip()
            if not at or not email:
                return {"ok": False, "error": "session token did not return account info"}

            at_expires = None
            if expires:
                try:
                    at_expires = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
                except Exception:
                    at_expires = None
            if at_expires and at_expires <= datetime.now(timezone.utc) + timedelta(minutes=5):
                return {"ok": False, "error": "Google Labs session is expired; reopen Flow and reload the extension"}

            try:
                credits_result = await flow_client.get_credits(at)
                credits = credits_result.get("credits", 0)
                user_paygate_tier = credits_result.get("userPaygateTier")
            except Exception as e:
                return {"ok": False, "error": f"Google Labs access token validation failed: {e}"}

            tokens = await self.db.get_all_tokens()
            target = None
            for token in tokens:
                if (token.email or "").strip().lower() == email.lower():
                    target = token
                    break
            if target is None and tokens:
                target = tokens[0]

            active_projects = []
            if target is not None:
                try:
                    active_projects = [
                        project for project in await self.db.get_projects_by_token(target.id)
                        if project.is_active
                    ]
                except Exception:
                    active_projects = []

            update_fields = dict(
                st=st,
                at=at,
                at_expires=at_expires,
                email=email,
                name=name,
                is_active=True,
                ban_reason=None,
                banned_at=None,
                credits=credits,
                user_paygate_tier=user_paygate_tier,
                image_enabled=True,
                video_enabled=True,
            )
            if active_projects:
                chosen_project = sorted(active_projects, key=lambda item: item.id or 0)[0]
                update_fields["current_project_id"] = chosen_project.project_id
                update_fields["current_project_name"] = chosen_project.project_name

            if target is not None:
                await self.db.update_token(target.id, **update_fields)
                token_id = target.id
            else:
                debug_logger.log_warning("[Extension Captcha] No existing token row to sync session into.")
                return {"ok": False, "error": "no token row exists"}

            debug_logger.log_info(
                f"[Extension Captcha] Synced Google Labs session for {email}, token_id={token_id}, expires={at_expires}"
            )
            print(
                f"[Extension Captcha] Synced Google Labs session for {email}, token_id={token_id}, expires={at_expires}",
                flush=True,
            )
            return {"ok": True, "email": email, "token_id": token_id}
        except Exception as e:
            debug_logger.log_error(f"[Extension Captcha] Session sync failed: {e}")
            print(f"[Extension Captcha] Session sync failed: {e}", flush=True)
            return {"ok": False, "error": str(e)}

    def _has_connection_for_route_key(self, route_key: str) -> bool:
        return self._select_connection(route_key) is not None

    async def has_connection_for_token(self, token_id: Optional[int]) -> tuple[bool, str]:
        route_key = await self._resolve_route_key(token_id)
        return self._has_connection_for_route_key(route_key), route_key

    async def handle_message(self, websocket: WebSocket, data: str):
        try:
            payload = json.loads(data)
            message_type = payload.get("type")

            if message_type == "register":
                conn = self._find_connection(websocket)
                if conn:
                    conn.route_key = (payload.get("route_key") or conn.route_key or "").strip()
                    conn.client_label = (payload.get("client_label") or conn.client_label or "").strip()
                    debug_logger.log_info(
                        f"[Extension Captcha] Client registered route_key={conn.route_key or '-'}, "
                        f"label={conn.client_label or '-'}"
                    )
                    print(
                        f"[Extension Captcha] Client registered route_key={conn.route_key or '-'}, "
                        f"label={conn.client_label or '-'}",
                        flush=True,
                    )
                    await self._send_ack(
                        websocket,
                        {
                            "type": "register_ack",
                            "route_key": conn.route_key,
                            "client_label": conn.client_label,
                        },
                    )
                return

            if message_type == "sync_session":
                result = await self._sync_session_token(payload)
                print(
                    f"[Extension Captcha] sync_session ok={bool(result.get('ok'))} "
                    f"email={result.get('email') or '-'} error={result.get('error') or '-'}",
                    flush=True,
                )
                await self._send_ack(
                    websocket,
                    {
                        "type": "sync_session_ack",
                        "ok": bool(result.get("ok")),
                        "email": result.get("email"),
                        "error": result.get("error"),
                    },
                )
                return

            req_id = payload.get("req_id")
            if req_id and req_id in self.pending_requests:
                future, owner_websocket = self.pending_requests[req_id]
                if websocket is not owner_websocket:
                    debug_logger.log_warning(f"[Extension Captcha] Ignoring response from non-owner connection: {req_id}")
                    return
                if not future.done():
                    future.set_result(payload)
        except Exception as e:
            debug_logger.log_error(f"[Extension Captcha] Error handling message: {e}")

    async def get_token(
        self,
        project_id: str,
        action: str = "IMAGE_GENERATION",
        timeout: int = 20,
        token_id: Optional[int] = None,
    ) -> Optional[str]:
        if not self.active_connections:
            debug_logger.log_warning("[Extension Captcha] No active extension connections available.")
            raise RuntimeError("Chrome Extension not connected or Google Labs tab not open.")

        route_key = await self._resolve_route_key(token_id)
        conn = self._select_connection(route_key)
        if conn is None:
            available = self._describe_routes() or "none"
            raise RuntimeError(
                f"No Chrome Extension connection matches token_id={token_id} route_key='{route_key}'. "
                f"Available route keys: {available}"
            )

        req_id = f"req_{uuid.uuid4().hex}"
        future = asyncio.get_running_loop().create_future()
        self.pending_requests[req_id] = (future, conn.websocket)

        request_data = {
            "type": "get_token",
            "req_id": req_id,
            "action": action,
            "project_id": project_id,
            "route_key": route_key,
        }

        try:
            debug_logger.log_info(
                f"[Extension Captcha] Dispatching token request via route_key={route_key or '-'}, "
                f"label={conn.client_label or '-'}, project_id={project_id}, action={action}"
            )
            await conn.websocket.send_text(json.dumps(request_data))
            result = await asyncio.wait_for(future, timeout=timeout)

            if result.get("status") == "success":
                tab_id = result.get("tab_id")
                try:
                    if tab_id is not None:
                        self.last_token_tabs[route_key] = int(tab_id)
                except (TypeError, ValueError):
                    pass
                return result.get("token")

            error_msg = result.get("error")
            debug_logger.log_error(f"[Extension Captcha] Error from extension: {error_msg}")
            return None

        except asyncio.TimeoutError:
            debug_logger.log_error(f"[Extension Captcha] Timeout waiting for token (req_id: {req_id})")
            return None
        except Exception as e:
            debug_logger.log_error(f"[Extension Captcha] Communication error: {e}")
            return None
        finally:
            self.pending_requests.pop(req_id, None)

    async def request_flow_api(
        self,
        url: str,
        json_data: Dict[str, Any],
        at_token: str,
        timeout: int = 60,
        token_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Submit Flow API from the Chrome tab that minted the token."""
        if not self.active_connections:
            raise RuntimeError("Chrome Extension not connected or Google Labs tab not open.")

        route_key = await self._resolve_route_key(token_id)
        conn = self._select_connection(route_key)
        if conn is None:
            available = self._describe_routes() or "none"
            raise RuntimeError(
                f"No Chrome Extension connection matches token_id={token_id} route_key='{route_key}'. "
                f"Available route keys: {available}"
            )

        req_id = f"req_{uuid.uuid4().hex}"
        future = asyncio.get_running_loop().create_future()
        self.pending_requests[req_id] = (future, conn.websocket)
        request_data = {
            "type": "submit_flow",
            "req_id": req_id,
            "url": url,
            "json_data": json_data,
            "at_token": at_token,
            "tab_id": self.last_token_tabs.get(route_key),
            "route_key": route_key,
        }

        try:
            await conn.websocket.send_text(json.dumps(request_data, ensure_ascii=False))
            response = await asyncio.wait_for(future, timeout=max(10, int(timeout or 60)))
            if response.get("status") != "success":
                raise RuntimeError(response.get("error") or "Chrome Flow request failed")

            transport = response.get("result")
            if not isinstance(transport, dict):
                raise RuntimeError("Chrome extension returned an invalid Flow response")
            if transport.get("error"):
                raise RuntimeError(f"Chrome Flow request failed: {transport.get('error')}")

            raw_text = str(transport.get("text") or "")
            try:
                payload = json.loads(raw_text) if raw_text else {}
            except Exception:
                payload = {"raw": raw_text[:2000]}
            status = int(transport.get("status") or 0)
            if status >= 400 or not bool(transport.get("ok")):
                error_info = payload.get("error") if isinstance(payload, dict) else None
                reason = ""
                if isinstance(error_info, dict):
                    for detail in error_info.get("details") or []:
                        if isinstance(detail, dict) and detail.get("reason"):
                            reason = str(detail.get("reason"))
                            break
                    message = str(error_info.get("message") or "")
                    reason = f"{reason}: {message}".strip(": ")
                raise RuntimeError(reason or f"Chrome Flow request returned HTTP {status}: {raw_text[:500]}")
            return payload
        finally:
            self.pending_requests.pop(req_id, None)

    async def report_flow_error(self, project_id: str, error_reason: str, error_message: str = ""):
        _ = project_id, error_message
        debug_logger.log_warning(f"[Extension Captcha] Flow error reported (ignoring): {error_reason}")
