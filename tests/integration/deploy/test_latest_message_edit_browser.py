"""Exercise latest-message editing with the real built chat SDK and isolated API fixtures."""

import json
import base64
import os
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

BASE_URL = os.environ.get("WELDON_TEST_CONSOLE_URL", "")
CHAT_ID = "10000000-0000-4000-8000-000000000041"
LATEST_ID = "10000000-0000-4000-8000-000000000042"


@pytest.mark.skipif(not BASE_URL, reason="Set WELDON_TEST_CONSOLE_URL")
@pytest.mark.parametrize(
    "running,reject,lost,switch,pre_send,waiting_model",
    [
        (False, False, False, False, False, False),
        (True, False, False, False, False, False),
        (False, True, False, False, False, False),
        (False, False, True, False, False, False),
        (False, False, False, True, False, False),
        (False, False, False, False, True, False),
        (False, False, False, False, False, True),
    ],
)
def test_latest_user_edit_cancel_and_resend(
    running, reject, lost, switch, pre_send, waiting_model
):
    from playwright.sync_api import sync_playwright

    file_part = {
        "type": "file",
        "file_url": "/api/console/attachments/upload-id",
        "filename": "original.txt",
    }
    image_url = "/api/console/attachments/10000000-0000-4000-8000-000000000098"
    image_part = {"type": "image", "image_url": image_url}
    messages = [
        {
            "id": str(uuid4()),
            "role": "user",
            "type": "message",
            "content": [{"type": "text", "text": "Earlier question"}],
        },
        {
            "id": "earlier-answer",
            "role": "assistant",
            "type": "message",
            "status": "completed",
            "content": [{"type": "text", "text": "Earlier answer"}],
        },
        {
            "id": LATEST_ID,
            "role": "user",
            "type": "message",
            "metadata": {"qwenpaw_editable": True},
            "content": [
                {"type": "text", "text": "Original question"},
                file_part,
                image_part,
            ],
        },
        {
            "id": "old-answer",
            "role": "assistant",
            "type": "message",
            "status": "completed",
            "content": [{"type": "text", "text": "Original answer"}],
        },
    ]
    chat = {
        "id": CHAT_ID,
        "session_id": CHAT_ID,
        "user_id": "default",
        "channel": "console",
        "name": "Editing verification",
        "created_at": "2026-10-14T00:00:00Z",
        "updated_at": "2026-10-14T00:00:00Z",
        "meta": {},
    }
    sent = []
    uploads = []
    paths = []
    delayed = []
    delay_history = [False]
    delayed_models = []
    hold_model = [False]
    other_id = "10000000-0000-4000-8000-000000000043"
    other_messages = [
        {
            "id": str(uuid4()),
            "role": "user",
            "type": "message",
            "metadata": {"qwenpaw_editable": True},
            "content": [{"type": "text", "text": "Other conversation question"}],
        }
    ]

    def api_fixture(route):
        if not urlsplit(route.request.url).path.startswith("/api/"):
            route.continue_()
            return
        path = urlsplit(route.request.url).path.removeprefix("/api")
        paths.append(path)
        if path.endswith("/model") and hold_model[0]:
            delayed_models.append(route)
            return
        if path == image_url.removeprefix("/api"):
            route.fulfill(
                status=200,
                content_type="image/png",
                body=base64.b64decode(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII="
                ),
            )
            return
        if path == f"/chats/{CHAT_ID}" and delay_history[0]:
            delayed.append(route)
            return
        if path == "/console/chat":
            body = route.request.post_data_json
            if body.get("reconnect"):
                route.fulfill(status=200, content_type="text/event-stream", body="")
                return
            sent.append(body)
            if reject:
                route.fulfill(
                    status=409,
                    content_type="application/json",
                    body=json.dumps({"detail": "latest_message_changed"}),
                )
                return
            edited = body["input"][-1]
            target_chat = body.get("conversation_id", CHAT_ID)
            answer = (
                "Other updated answer" if target_chat == other_id else "Updated answer"
            )
            if target_chat == other_id:
                other_messages[:] = [
                    {"id": str(uuid4()), **edited},
                    {
                        "id": "other-new-answer",
                        "role": "assistant",
                        "type": "message",
                        "status": "completed",
                        "content": [{"type": "text", "text": answer}],
                    },
                ]
            elif not lost or len(sent) == 1:
                messages[2:] = [
                    {"id": str(uuid4()), **edited},
                    {
                        "id": "new-answer",
                        "role": "assistant",
                        "type": "message",
                        "status": "completed",
                        "content": [{"type": "text", "text": "Updated answer"}],
                    },
                ]
            if lost and len(sent) == 1:
                route.abort("failed")
                return
            wire = {
                "id": "new-answer",
                "object": "message",
                "role": "assistant",
                "type": "message",
                "status": "completed",
                "content": [{"type": "text", "text": answer, "index": 0}],
            }
            route.fulfill(
                status=200,
                content_type="text/event-stream",
                headers={
                    "X-QwenPaw-Chat-Id": target_chat,
                    "X-QwenPaw-Can-Edit": "true",
                },
                body="data: "
                + json.dumps(wire)
                + "\n\ndata: "
                + json.dumps(
                    {
                        "object": "response",
                        "status": "completed",
                        "qwenpaw_completion_only": True,
                    }
                )
                + "\n\n",
            )
            return
        if path == "/console/upload":
            uploads.append(route.request.post_data)
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"url": "/api/console/attachments/uploaded-text-id"}),
            )
            return
        if path.endswith("/stream") or path == "/console/inbox/events":
            route.fulfill(status=204)
            return
        if path in ("/user-input/pending", "/runtime-status/current"):
            payload = None
        elif path == "/auth/status":
            payload = {"enabled": False, "mode": "legacy", "has_users": True}
        elif path == "/agents":
            payload = {
                "agents": [{"id": "default", "name": "Test agent", "enabled": True}]
            }
        elif path == "/chats":
            payload = [
                chat,
                {
                    **chat,
                    "id": other_id,
                    "session_id": other_id,
                    "name": "Other verification chat",
                },
            ]
        elif path == f"/chats/{other_id}":
            payload = {"messages": other_messages, "status": "idle"}
        elif path == f"/chats/{CHAT_ID}":
            payload = {
                "messages": messages,
                "status": "running" if running and not sent else "idle",
            }
        elif path == f"/chats/{CHAT_ID}/status":
            payload = {"status": "running" if running and not sent else "idle"}
        elif path.endswith("/model") or path == "/model-catalog/default":
            payload = {
                "active_llm": {"provider_id": "test", "model": "test-model"},
                "source": "agent_default",
                "model_override": None,
                "locked": False,
            }
        elif path == "/model-catalog":
            payload = {
                "models": [
                    {
                        "provider_id": "test",
                        "provider_name": "Test",
                        "model": "test-model",
                        "name": "test-model",
                        "supports_image": True,
                        "supports_video": False,
                    }
                ]
            }
        elif path.endswith("/project-dir") or path == "/workspace/project-directory":
            payload = {
                "project_dir": "/workspace",
                "source": "workspace_fallback",
                "exists": True,
            }
        elif path in (
            "/frontend_plugin",
            "/console/push-messages",
            "/slash/catalog",
            "/loops",
        ):
            payload = []
        else:
            payload = {}
        route.fulfill(
            status=200, content_type="application/json", body=json.dumps(payload)
        )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(locale="zh-CN")
        context.route("**/api/**", api_fixture)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(
                f"{BASE_URL.rstrip('/')}/chat/{CHAT_ID}", wait_until="domcontentloaded"
            )
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                # Chat polls continuously; the rendered transcript is the
                # readiness boundary when background requests prevent idle.
                pass
            page.get_by_text("Original answer", exact=True).wait_for(timeout=20000)
            dismiss = page.get_by_text("我知道了", exact=True)
            if dismiss.is_visible():
                dismiss.click()
            pencil = page.get_by_role("button", name="编辑消息", exact=True)
            assert pencil.count() == 1, page.locator("body").inner_text()[-1800:]
            pencil.click()
            editor = page.get_by_role("textbox", name="编辑消息", exact=True)
            assert editor.input_value() == "Original question"
            assert (
                page.locator('[data-testid="latest-message-editor"]')
                .get_by_text("original.txt", exact=True)
                .count()
                == 1
            )
            image_preview = page.locator(
                '[data-testid="latest-message-editor"] img[src*="' + image_url + '"]'
            )
            image_preview.wait_for(timeout=5000)
            assert image_preview.count() == 1
            editor.fill("Cancelled draft")
            page.get_by_role("button", name="取消", exact=True).click()
            assert not sent
            assert page.get_by_text("Original question", exact=True).count() == 1
            pencil.click()
            editor.fill("Edited question")
            delay_history[0] = switch
            hold_model[0] = waiting_model
            if pre_send:
                page.evaluate(
                    """() => {
                    const schedule = window.setTimeout.bind(window);
                    window.setTimeout = (fn, delay, ...args) => {
                        if (delay === 100 && !window.__editTimerHeld) {
                            window.__editTimerHeld = true;
                            return schedule(fn, 2000, ...args);
                        }
                        return schedule(fn, delay, ...args);
                    };
                }"""
                )
            page.get_by_role("button", name="重新发送", exact=True).click()
            if waiting_model:
                for _ in range(100):
                    if delayed_models:
                        break
                    page.wait_for_timeout(20)
                assert delayed_models
                assert not sent
                page.get_by_text("Edited question", exact=True).wait_for(timeout=5000)
                assert page.get_by_text("Original question", exact=True).count() == 0
                assert page.get_by_text("original.txt", exact=True).count() == 1
                assert page.locator('img[src*="' + image_url + '"]').count() == 1
                assert not uploads
                hold_model[0] = False
                for model_route in delayed_models:
                    model_route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps(
                            {
                                "active_llm": {
                                    "provider_id": "test",
                                    "model": "test-model",
                                },
                                "source": "agent_default",
                                "model_override": None,
                                "locked": False,
                            }
                        ),
                    )
            if pre_send:
                page.wait_for_function("window.__editTimerHeld === true")
                assert not sent
                page.evaluate(
                    "path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }",
                    f"/chat/{other_id}",
                )
                page.get_by_text("Other conversation question", exact=True).wait_for(
                    timeout=15000
                )
                page.wait_for_timeout(2200)
                assert not sent
                page.get_by_role("button", name="编辑消息", exact=True).click()
                page.get_by_role("textbox", name="编辑消息", exact=True).fill(
                    "Edited B question"
                )
                page.get_by_role("button", name="重新发送", exact=True).click()
                page.get_by_text("Other updated answer", exact=True).wait_for(
                    timeout=15000
                )
                page.locator("textarea:visible").last.fill("New B question")
                page.locator("textarea:visible").last.press("Enter")
                for _ in range(100):
                    if len(sent) == 2:
                        break
                    page.wait_for_timeout(30)
                assert len(sent) == 2
                assert all(body["conversation_id"] == other_id for body in sent)
                assert "edit_last_message" in sent[0]
                assert "edit_last_message" not in sent[1]
                assert not errors, errors
                return
            if switch:
                for _ in range(100):
                    if delayed:
                        break
                    page.wait_for_timeout(20)
                assert delayed
                page.evaluate(
                    "path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }",
                    f"/chat/{other_id}",
                )
                page.get_by_text("Other conversation question", exact=True).wait_for(
                    timeout=15000
                )
                delayed[0].fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"messages": messages, "status": "idle"}),
                )
                page.wait_for_timeout(250)
                assert not sent
                assert page.get_by_text("Original answer", exact=True).count() == 0
                assert (
                    page.get_by_text("Other conversation question", exact=True).count()
                    == 1
                )
                assert page.url.endswith(f"/chat/{other_id}")
                assert not errors, errors
                return
            if lost:
                page.get_by_role("alert").wait_for(timeout=15000)
                assert editor.input_value() == "Edited question"
                page.get_by_role("button", name="重新发送", exact=True).click()
            if reject:
                page.get_by_role("alert").filter(has_text="最新消息").wait_for(
                    timeout=15000
                )
                assert editor.input_value() == "Edited question"
                assert page.get_by_text("Original answer", exact=True).count() == 1
                page.reload(wait_until="domcontentloaded")
                page.get_by_text("Original answer", exact=True).wait_for(timeout=15000)
                assert page.get_by_text("Edited question", exact=True).count() == 0
            else:
                page.get_by_text("Updated answer", exact=True).wait_for(timeout=15000)
                assert page.get_by_text("助手返回了空响应。", exact=True).count() == 0
                assert page.get_by_text("Original answer", exact=True).count() == 0
                assert page.get_by_text("Earlier answer", exact=True).count() == 1
                assert page.get_by_text("Edited question", exact=True).count() == 1
                assert page.get_by_role("button", name="编辑消息", exact=True).count() == 1
                page.reload(wait_until="domcontentloaded")
                page.get_by_text("Updated answer", exact=True).wait_for(timeout=15000)
                assert page.get_by_text("Original question", exact=True).count() == 0
            assert len(sent) == (2 if lost else 1)
            if lost:
                assert sent[0]["edit_last_message"] == sent[1]["edit_last_message"]
            assert sent[0]["edit_last_message"]["message_id"] == LATEST_ID
            assert sent[0]["conversation_id"] == CHAT_ID
            assert any(
                part.get("type") == "file" for part in sent[0]["input"][-1]["content"]
            )
            assert any(
                part.get("type") == "image"
                and urlsplit(part.get("image_url", "")).path == image_url
                for part in sent[0]["input"][-1]["content"]
            )
            assert page.url.endswith(f"/chat/{CHAT_ID}")
            assert not errors, errors
            if not any((running, reject, lost, switch, pre_send, waiting_model)):
                upload_button = page.get_by_role("button", name="上传附件", exact=True)
                upload_button.hover()
                page.get_by_role("tooltip").filter(
                    has_text="支持文档、图片、视频、音频等多种格式"
                ).wait_for(timeout=5000)
                file_input = page.locator('input[type="file"]').first
                assert file_input.get_attribute("accept") in (None, "", "*")
                file_input.set_input_files(
                    {
                        "name": "notes.txt",
                        "mimeType": "text/plain",
                        "buffer": b"Attachment upload verification",
                    }
                )
                for _ in range(100):
                    if uploads:
                        break
                    page.wait_for_timeout(30)
                assert len(uploads) == 1
                assert page.get_by_text("当前模型仅检测到图片支持", exact=False).count() == 0
                assert page.get_by_text("当前模型未检测到多模态能力", exact=False).count() == 0
        except Exception:
            page.screenshot(
                path=f"build/latest-message-edit-{running}-{reject}.png", full_page=True
            )
            print(
                json.dumps(
                    {
                        "paths": sorted(set(paths)),
                        "sent": len(sent),
                        "errors": errors,
                        "page": page.locator("body").inner_text()[-2000:],
                    },
                    ensure_ascii=False,
                )
            )
            raise
        finally:
            browser.close()
