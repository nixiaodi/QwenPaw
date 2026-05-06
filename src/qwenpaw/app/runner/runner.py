# -*- coding: utf-8 -*-
# pylint: disable=unused-argument too-many-branches too-many-statements
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncGenerator, Coroutine

from agentscope.message import Msg, TextBlock
from agentscope_runtime.engine.runner import Runner
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest
from agentscope_runtime.engine.schemas.exception import (
    AgentException,
    AppBaseException,
)
from dotenv import load_dotenv

from .command_dispatch import (
    _get_last_user_text,
    _is_command,
    run_command_path,
)
from .query_error_dump import write_query_error_dump
from .mission_dispatch import (
    maybe_handle_mission_command,
    detect_active_mission_phase,
)
from .session import SafeJSONSession
from .utils import build_env_context
from ..channels.schema import DEFAULT_CHANNEL
from ...agents.react_agent import QwenPawAgent
from ...exceptions import convert_model_exception
from ...agents.skill_runtime import (
    SkillIntentRouter,
    SkillRoute,
    discover_enabled_skills,
    render_skill_info,
    render_skill_list,
    route_to_prompt,
)
from ...config.config import load_agent_config
from ...constant import WORKING_DIR
from ...plan.intent_router import PlanIntentRouter

if TYPE_CHECKING:
    from ...agents.memory import BaseMemoryManager
    from ...agents.context import BaseContextManager

logger = logging.getLogger(__name__)


_PRINT_END_SIGNAL = "[END]"


async def _cancel_streaming_agent_task(task: asyncio.Task) -> None:
    if task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.debug(
            "Streaming agent task finished with error during cancellation",
            exc_info=True,
        )


async def _stream_printing_messages_interruptible(
    *,
    agents: list[Any],
    coroutine_task: Coroutine[Any, Any, Msg],
) -> AsyncGenerator[tuple[Msg, bool], None]:
    """Like agentscope.stream_printing_messages, but cancel the agent task
    promptly when the outer stream is stopped or closed.
    """

    queue: asyncio.Queue = asyncio.Queue()
    for agent in agents:
        agent.set_msg_queue_enabled(True, queue)

    task = asyncio.create_task(coroutine_task)
    if task.done():
        await queue.put(_PRINT_END_SIGNAL)
    else:
        task.add_done_callback(lambda _: queue.put_nowait(_PRINT_END_SIGNAL))

    try:
        while True:
            printing_msg = await queue.get()
            if (
                isinstance(printing_msg, str)
                and printing_msg == _PRINT_END_SIGNAL
            ):
                break
            msg, last, _ = printing_msg
            yield msg, last

        exception = task.exception()
        if exception is not None:
            raise exception from None
    except asyncio.CancelledError:
        await _cancel_streaming_agent_task(task)
        raise
    finally:
        await _cancel_streaming_agent_task(task)


class AgentRunner(Runner):
    def __init__(
        self,
        agent_id: str = "default",
        workspace_dir: Path | None = None,
        task_tracker: Any | None = None,
    ) -> None:
        super().__init__()
        self.framework_type = "agentscope"
        self.agent_id = agent_id  # Store agent_id for config loading
        self.workspace_dir = (
            workspace_dir  # Store workspace_dir for prompt building
        )
        self._chat_manager = None  # Store chat_manager reference
        self._mcp_manager = None  # MCP client manager for hot-reload
        self._workspace: Any = None  # Workspace instance for control commands
        self.memory_manager: BaseMemoryManager | None = None
        self.context_manager: BaseContextManager | None = None
        self._task_tracker = task_tracker  # Task tracker for background tasks

    def set_chat_manager(self, chat_manager):
        """Set chat manager for auto-registration.

        Args:
            chat_manager: ChatManager instance
        """
        self._chat_manager = chat_manager

    def set_mcp_manager(self, mcp_manager):
        """Set MCP client manager for hot-reload support.

        Args:
            mcp_manager: MCPClientManager instance
        """
        self._mcp_manager = mcp_manager

    def set_workspace(self, workspace):
        """Set workspace for control command handlers.

        Args:
            workspace: Workspace instance
        """
        self._workspace = workspace

    @staticmethod
    def _parse_skill_query(
        query: str,
    ) -> tuple[str, str] | None:
        """Parse ``/name [input]`` or ``/[name with spaces] [input]``.

        Bracket form ``/[...]`` handles spaces in skill names and
        bypasses built-in command priority.

        Returns ``(skill_name, user_input)`` or ``None``.
        """
        stripped = query.strip()
        if not stripped.startswith("/"):
            return None

        rest = stripped[1:]  # drop leading /

        # /[skill name] input — bracket form
        if rest.startswith("["):
            close = rest.find("]")
            if close < 0:
                return None
            name = rest[1:close].strip().lower()
            user_input = rest[close + 1 :].strip()
            return (name, user_input) if name else None

        # /name input — plain form
        parts = rest.split(None, 1)
        if not parts:
            return None
        name = parts[0].lower()
        user_input = parts[1] if len(parts) > 1 else ""
        return (name, user_input) if name else None

    @staticmethod
    def _maybe_inject_skill(
        query: str | None,
        msgs: list,
        route: SkillRoute | None,
    ) -> Msg | None:
        """Apply a resolved skill route to the current turn.

        Returns a ``Msg`` to short-circuit (skill info), or ``None``
        to continue to the LLM with rewritten ``msgs``.
        """
        if route is None:
            return None

        if route.kind == "list":
            return Msg(
                name="Friday",
                role="assistant",
                content=[
                    TextBlock(
                        type="text",
                        text=render_skill_list(list(route.skills)),
                    ),
                ],
            )

        if route.kind == "info" and route.skill is not None:
            logger.info("Skill info: %s", route.skill.name)
            return Msg(
                name="Friday",
                role="assistant",
                content=[
                    TextBlock(
                        type="text",
                        text=render_skill_info(route.skill),
                    ),
                ],
            )

        if route.kind == "invoke" and msgs:
            original = query or ""
            prompt = route_to_prompt(route)
            if prompt:
                AgentRunner._rewrite_last_message_text(
                    msgs,
                    prompt + original,
                )
                logger.info(
                    "Skill invocation routed: skill=%s reason=%s "
                    "candidates=%s",
                    route.skill.name if route.skill else "",
                    route.reason,
                    route.candidates,
                )
        return None

    async def _maybe_resolve_skill_clarification(
        self,
        *,
        route: SkillRoute | None,
        query: str | None,
        session_id: str,
        root_session_id: str,
        user_id: str,
        channel: str,
    ) -> tuple[SkillRoute | None, Msg | None]:
        """Ask the user to choose a skill when routing is ambiguous."""
        if route is None or route.kind != "clarify":
            return route, None

        from ...user_input.schemas import UserInputOption, UserInputQuestion
        from ...user_input.service import get_user_input_service

        options = [
            UserInputOption(
                label=skill.name,
                value=skill.name,
                description=skill.description or skill.display_name,
            )
            for skill in route.skills
        ]
        if not options:
            return None, Msg(
                name="Friday",
                role="assistant",
                content=[
                    TextBlock(
                        type="text",
                        text="检测到多个可能的技能，但没有可展示的候选项。",
                    ),
                ],
            )

        service = get_user_input_service()
        pending = await service.create_pending(
            session_id=session_id,
            root_session_id=root_session_id,
            user_id=user_id,
            channel=channel,
            agent_id=self.agent_id,
            title="选择要使用的技能",
            questions=[
                UserInputQuestion(
                    id="skill",
                    question=(
                        "这个请求匹配到多个已启用技能，"
                        "请选择本次要使用哪一个。"
                    ),
                    kind="single_choice",
                    options=options,
                    required=True,
                ),
            ],
            timeout_seconds=300.0,
        )
        result = await service.wait_for_result(
            pending.request_id,
            pending.timeout_seconds,
        )

        if result.status != "answered":
            logger.info(
                "Skill clarification not answered: status=%s candidates=%s",
                result.status,
                route.candidates,
            )
            return None, Msg(
                name="Friday",
                role="assistant",
                content=[
                    TextBlock(
                        type="text",
                        text=(
                            "我检测到多个可用技能都可能处理这个请求，"
                            "但本次没有选择具体技能，已暂停执行。"
                        ),
                    ),
                ],
            )

        selected_name = str(result.answers.get("skill") or "").strip()
        selected = next(
            (
                skill
                for skill in route.skills
                if skill.name.lower() == selected_name.lower()
            ),
            None,
        )
        if selected is None:
            logger.info(
                "Skill clarification selected invalid skill: %s",
                selected_name,
            )
            return None, Msg(
                name="Friday",
                role="assistant",
                content=[
                    TextBlock(
                        type="text",
                        text="选择的技能无效，请重新发起请求并选择可用技能。",
                    ),
                ],
            )

        logger.info(
            "Skill clarification selected: skill=%s candidates=%s",
            selected.name,
            route.candidates,
        )
        return SkillRoute(
            kind="invoke",
            skill=selected,
            args=query or "",
            reason="semantic_user_selected",
            candidates=route.candidates,
        ), None

    @staticmethod
    def _rewrite_last_message_text(
        msgs: list,
        new_text: str,
    ) -> None:
        """Rewrite the text content of the last message in-place."""
        if not msgs:
            return
        last = msgs[-1]
        content = getattr(last, "content", None)
        if isinstance(content, list):
            for i, block in enumerate(content):
                if isinstance(block, dict) and block.get("type") == "text":
                    content[i] = TextBlock(
                        type="text",
                        text=new_text,
                    )
                    return
            content.insert(
                0,
                TextBlock(type="text", text=new_text),
            )
        elif isinstance(content, str):
            last.content = new_text

    async def query_handler(
        self,
        msgs,
        request: AgentRequest = None,
        **kwargs,
    ):
        """
        Handle agent query.
        """
        logger.debug(
            f"AgentRunner.query_handler called: agent_id={self.agent_id}, "
            f"msgs={msgs}, request={request}",
        )
        query = _get_last_user_text(msgs)
        session_id = getattr(request, "session_id", "") or ""

        # Check if query is a command (including /approval)
        logger.debug(f"Query: {query!r}, is_command: {_is_command(query)}")
        if query and _is_command(query):
            logger.info("Command path: %s", query.strip()[:50])
            async for msg, last in run_command_path(request, msgs, self):
                yield msg, last
            return

        logger.debug(
            f"AgentRunner.stream_query: request={request}, "
            f"agent_id={self.agent_id}",
        )

        # Set agent context for model creation
        from ..agent_context import (
            set_current_agent_id,
            set_current_session_id,
            set_current_root_session_id,
        )

        set_current_agent_id(self.agent_id)

        # Set session_id in context for token usage tracking
        set_current_session_id(session_id)

        agent = None
        chat = None
        session_state_loaded = False
        try:
            session_id = request.session_id
            user_id = request.user_id
            channel = getattr(request, "channel", DEFAULT_CHANNEL)

            logger.info(
                "Handle agent query:\n%s",
                json.dumps(
                    {
                        "session_id": session_id,
                        "user_id": user_id,
                        "channel": channel,
                        "msgs_len": len(msgs) if msgs else 0,
                        "msgs_str": str(msgs)[:300] + "...",
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            )

            env_context = build_env_context(
                session_id=session_id,
                user_id=user_id,
                channel=channel,
                working_dir=(
                    str(self.workspace_dir)
                    if self.workspace_dir
                    else str(WORKING_DIR)
                ),
            )

            # Get MCP clients from manager (hot-reloadable)
            mcp_clients = []
            if self._mcp_manager is not None:
                mcp_clients = await self._mcp_manager.get_clients()

            # Load agent-specific configuration
            agent_config = load_agent_config(self.agent_id)

            logger.debug(f"Enabled MCP: {mcp_clients}")

            # Build base request context
            base_request_context = {
                "session_id": session_id,
                "user_id": user_id,
                "channel": channel,
                "agent_id": self.agent_id,
            }

            # Extract root_session_id from request payload (agent chat)
            payload_root_session = getattr(request, "root_session_id", "")
            if payload_root_session and isinstance(payload_root_session, str):
                base_request_context["root_session_id"] = payload_root_session
                set_current_root_session_id(payload_root_session)
                root_preview = (
                    payload_root_session[:12]
                    if len(payload_root_session) >= 12
                    else payload_root_session
                )
                logger.debug(
                    "Runner: using root_session_id from payload: %s",
                    root_preview,
                )
            else:
                # Current session is the root
                base_request_context["root_session_id"] = session_id
                set_current_root_session_id(session_id)
                session_preview = (
                    session_id[:12] if len(session_id) >= 12 else session_id
                )
                logger.debug(
                    "Runner: current session is root: %s",
                    session_preview,
                )

            # Mission Mode: /mission
            _ws = self.workspace_dir or WORKING_DIR
            mission_info: dict | None = None

            mission_result = await maybe_handle_mission_command(
                query=query,
                msgs=msgs,
                workspace_dir=_ws,
                agent_id=self.agent_id,
                rewrite_fn=self._rewrite_last_message_text,
                session_id=session_id,
            )
            if isinstance(mission_result, Msg):
                yield mission_result, True
                return
            if isinstance(mission_result, dict):
                mission_info = mission_result

            # Active mission: auto-detect follow-up messages
            # (e.g., user confirms PRD without typing /mission again)
            if mission_info is None:
                mission_info = detect_active_mission_phase(
                    _ws,
                    session_id=session_id,
                )

            # Mission Mode: inject context reminder for active mission
            if mission_info is not None:
                # Inject context reminder for active mission
                loop_dir = mission_info.get("loop_dir", "")
                phase = mission_info.get("mission_phase", 1)
                if phase == 1:
                    refresher = (
                        f"[Mission active — dir: `{loop_dir}`]\n"
                        f"You are in Mission Phase 1 (PRD review). "
                        f"The user's message follows.\n"
                        f"If the user is confirming the PRD, update "
                        f"`{loop_dir}/loop_config.json` setting "
                        f"`current_phase` to `execution_confirmed`.\n"
                        f"If the user requests changes, modify "
                        f"prd.json.\n---\n"
                    )
                elif phase == 2:
                    refresher = (
                        f"[Mission active — dir: `{loop_dir}`]\n"
                        f"You are in Mission Phase 2 (execution). "
                        f"The user's follow-up message follows.\n"
                        f"Continue the worker → verifier pipeline. "
                        f"Check prd.json progress and dispatch workers "
                        f"for remaining stories.\n---\n"
                    )
                else:
                    refresher = f"[Mission active — dir: `{loop_dir}`]\n---\n"
                original = query or ""
                self._rewrite_last_message_text(
                    msgs,
                    refresher + original,
                )

            # Skill routing: explicit slash/name, bare skill name, or
            # high-confidence description intent match.
            skill_route: SkillRoute | None = None
            skill_response: Msg | None = None
            if mission_info is None:
                try:
                    enabled_skills = discover_enabled_skills(_ws, channel)
                    skill_route = SkillIntentRouter(enabled_skills).route(
                        query,
                    )
                    if skill_route is not None:
                        logger.info(
                            "Skill router result: kind=%s skill=%s "
                            "reason=%s candidates=%s",
                            skill_route.kind,
                            (
                                skill_route.skill.name
                                if skill_route.skill is not None
                                else ""
                            ),
                            skill_route.reason,
                            skill_route.candidates,
                        )
                        if skill_route.kind in {"list", "info"}:
                            skill_response = self._maybe_inject_skill(
                                query,
                                msgs,
                                skill_route,
                            )
                            if skill_response is not None:
                                yield skill_response, True
                                return
                        if skill_route.kind == "clarify":
                            (
                                skill_route,
                                skill_response,
                            ) = await self._maybe_resolve_skill_clarification(
                                route=skill_route,
                                query=query,
                                session_id=session_id,
                                root_session_id=base_request_context[
                                    "root_session_id"
                                ],
                                user_id=user_id,
                                channel=channel,
                            )
                            if skill_response is not None:
                                yield skill_response, True
                                return
                except Exception:
                    logger.warning("Skill routing failed", exc_info=True)

            # --- Plan Mode ------------------------------------------
            plan_notebook = None
            plan_cfg = getattr(agent_config, "plan", None)
            plan_enabled = getattr(plan_cfg, "enabled", False)
            if plan_enabled:
                try:
                    from agentscope.plan import (
                        PlanNotebook,
                        InMemoryPlanStorage,
                    )
                    from ...plan.hints import (
                        SimplePlanToHint,
                        set_plan_auto_execute,
                        set_plan_gate,
                    )

                    hint_gen = SimplePlanToHint()
                    plan_notebook = PlanNotebook(
                        plan_to_hint=hint_gen,
                        storage=InMemoryPlanStorage(),
                    )
                    hint_gen.bind_notebook(plan_notebook)

                    # Detect /plan <description> and set gate
                    if query and query.strip().lower().startswith("/plan "):
                        plan_desc = query.strip()[6:].strip()
                        if plan_desc:
                            set_plan_gate(plan_notebook, enabled=True)
                            set_plan_auto_execute(
                                plan_notebook,
                                enabled=False,
                            )
                            self._rewrite_last_message_text(
                                msgs,
                                plan_desc,
                            )
                            logger.info(
                                "Plan mode: /plan gate set, desc=%s",
                                plan_desc[:60],
                            )
                    elif (
                        mission_info is None
                        and (
                            skill_route is None
                            or skill_route.reason == "semantic_description"
                        )
                    ):
                        route = PlanIntentRouter(
                            threshold=getattr(
                                plan_cfg,
                                "complexity_threshold",
                                "medium",
                            ),
                            auto_enabled=getattr(
                                plan_cfg,
                                "auto_enabled",
                                True,
                            ),
                        ).route(query)
                        if route is not None:
                            set_plan_gate(plan_notebook, enabled=True)
                            set_plan_auto_execute(
                                plan_notebook,
                                enabled=getattr(
                                    plan_cfg,
                                    "auto_execute",
                                    False,
                                ),
                            )
                            logger.info(
                                "Plan router result: reason=%s score=%s "
                                "matched=%s auto_execute=%s",
                                route.reason,
                                route.score,
                                route.matched,
                                getattr(plan_cfg, "auto_execute", False),
                            )
                            if query:
                                self._rewrite_last_message_text(msgs, query)

                    # Register SSE broadcast hook + state tracking
                    from ...plan.broadcast import broadcast_plan_update
                    from ...plan.schemas import plan_to_response

                    def _on_plan_change(  # pylint: disable=protected-access
                        nb,
                        plan,
                    ):
                        had_plan = getattr(nb, "_qp_had_plan", False)
                        prev_id = getattr(nb, "_qp_prev_plan_id", None)

                        if plan is not None:
                            cur_id = plan.id
                            if not had_plan or cur_id != prev_id:
                                nb._plan_just_mutated = True
                            nb._qp_prev_plan_id = cur_id
                        else:
                            if had_plan:
                                nb._plan_recently_finished = True
                            nb._qp_prev_plan_id = None
                        nb._qp_had_plan = plan is not None

                        payload = {
                            "type": "plan_update",
                            "plan": (
                                plan_to_response(plan).model_dump()
                                if plan is not None
                                else None
                            ),
                        }
                        broadcast_plan_update(
                            self.agent_id,
                            payload,
                            session_id=session_id,
                        )

                    plan_notebook.register_plan_change_hook(
                        "broadcast",
                        _on_plan_change,
                    )
                except Exception:
                    logger.warning(
                        "Failed to create PlanNotebook",
                        exc_info=True,
                    )
                    plan_notebook = None

            if (
                skill_route is not None
                and skill_route.kind == "invoke"
                and not getattr(plan_notebook, "_plan_tool_gate", False)
            ):
                skill_response = self._maybe_inject_skill(
                    query,
                    msgs,
                    skill_route,
                )
                if skill_response is not None:
                    yield skill_response, True
                    return

            agent = QwenPawAgent(
                agent_config=agent_config,
                env_context=env_context,
                mcp_clients=mcp_clients,
                memory_manager=self.memory_manager,
                context_manager=self.context_manager,
                request_context=base_request_context,
                workspace_dir=self.workspace_dir,
                task_tracker=self._task_tracker,
                plan_notebook=plan_notebook,
            )
            await agent.register_mcp_clients()
            agent.set_console_output_enabled(enabled=False)

            logger.debug(
                f"Agent Query msgs {msgs}",
            )

            name = "New Chat"
            if len(msgs) > 0:
                content = msgs[0].get_text_content()
                if content:
                    name = msgs[0].get_text_content()[:10]
                else:
                    name = "Media Message"

            logger.debug(
                f"DEBUG chat_manager status: "
                f"_chat_manager={self._chat_manager}, "
                f"is_none={self._chat_manager is None}, "
                f"agent_id={self.agent_id}",
            )

            if self._chat_manager is not None:
                logger.debug(
                    f"Runner: Calling get_or_create_chat for "
                    f"session_id={session_id}, user_id={user_id}, "
                    f"channel={channel}, name={name}",
                )
                chat = await self._chat_manager.get_or_create_chat(
                    session_id,
                    user_id,
                    channel,
                    name=name,
                )
                logger.debug(f"Runner: Got chat: {chat.id}")
            else:
                logger.warning(
                    f"ChatManager is None! Cannot auto-register chat for "
                    f"session_id={session_id}",
                )

            # Ensure session file has a valid plan_notebook dict
            # to prevent TypeError/KeyError during load_state_dict
            if plan_notebook is not None:
                try:
                    _states = await self.session.get_session_state_dict(
                        session_id=session_id,
                        user_id=user_id,
                        allow_not_exist=True,
                    )
                    _agent_st = _states.get("agent", {})
                    _nb_val = _agent_st.get("plan_notebook")
                    if _agent_st and (
                        "plan_notebook" not in _agent_st
                        or not isinstance(_nb_val, dict)
                    ):
                        await self.session.update_session_state(
                            session_id=session_id,
                            key="agent.plan_notebook",
                            value=plan_notebook.state_dict(),
                            user_id=user_id,
                            create_if_not_exist=False,
                        )
                except Exception:
                    logger.debug(
                        "Pre-populate plan_notebook skipped",
                        exc_info=True,
                    )

            try:
                await self.session.load_session_state(
                    session_id=session_id,
                    user_id=user_id,
                    agent=agent,
                )
            except KeyError as e:
                logger.warning(
                    "load_session_state skipped (state schema mismatch): %s; "
                    "will save fresh state on completion to recover file",
                    e,
                )
            session_state_loaded = True

            # Rebuild system prompt so it always reflects the latest
            # AGENTS.md / SOUL.md / PROFILE.md, not the stale one saved
            # in the session state.
            agent.rebuild_sys_prompt()

            # --- Execution: Mission Mode (phased) or standard -----
            if mission_info is not None:
                from ...agents.mission.mission_runner import (
                    run_mission_phase1,
                    run_mission_phase2,
                )

                phase = mission_info["mission_phase"]
                loop_dir = Path(mission_info["loop_dir"])
                max_iters = mission_info.get(
                    "max_iterations",
                    20,
                )

                if phase == 1:
                    async for msg, last in run_mission_phase1(
                        agent=agent,
                        msgs=msgs,
                        loop_dir=loop_dir,
                        max_iterations=max_iters,
                        agent_id=self.agent_id,
                    ):
                        yield msg, last
                else:
                    async for msg, last in run_mission_phase2(
                        agent=agent,
                        msgs=msgs,
                        loop_dir=loop_dir,
                        max_iterations=max_iters,
                        agent_id=self.agent_id,
                    ):
                        yield msg, last
            else:
                async for msg, last in _stream_printing_messages_interruptible(
                    agents=[agent],
                    coroutine_task=agent(msgs),
                ):
                    yield msg, last

        except asyncio.CancelledError as exc:
            logger.info(f"query_handler: {session_id} cancelled!")

            # Cancel all pending approvals for this root session
            root_session_id = base_request_context.get(
                "root_session_id",
                session_id,
            )
            from ..approvals.service import get_approval_service

            approval_svc = get_approval_service()
            cancelled_count = (
                await approval_svc.cancel_all_pending_by_root_session(
                    root_session_id,
                )
            )
            if cancelled_count > 0:
                logger.info(
                    "Auto-denied %d pending approval(s) for root session %s",
                    cancelled_count,
                    root_session_id[:8]
                    if len(root_session_id) >= 8
                    else root_session_id,
                )

            if agent is not None:
                await agent.interrupt()
            raise AgentException("Task has been cancelled!") from exc
        except AppBaseException:
            raise
        except Exception as e:
            model_name = None
            if agent and hasattr(agent, "model"):
                model_name = getattr(agent.model, "model_name", None)

            converted = convert_model_exception(e, model_name)

            # Preserve all original error dump logic
            debug_dump_path = write_query_error_dump(
                request=request,
                exc=converted,
                locals_=locals(),
            )
            path_hint = (
                f"\n(Details:  {debug_dump_path})" if debug_dump_path else ""
            )
            logger.exception(f"Error in query handler: {converted}{path_hint}")
            if debug_dump_path:
                setattr(converted, "debug_dump_path", debug_dump_path)
                if hasattr(converted, "add_note"):
                    converted.add_note(
                        f"(Details:  {debug_dump_path})",
                    )
                suffix = f"\n(Details:  {debug_dump_path})"
                if hasattr(converted, "message") and isinstance(
                    converted.message,
                    str,
                ):
                    converted.message += suffix
                elif converted.args:
                    converted.args = (
                        f"{converted.args[0]}{suffix}",
                    ) + converted.args[1:]
            raise converted from e
        finally:
            if agent is not None and session_state_loaded:
                await self.session.save_session_state(
                    session_id=session_id,
                    user_id=user_id,
                    agent=agent,
                )

            if self._chat_manager is not None and chat is not None:
                await self._chat_manager.touch_chat(chat.id)

    async def init_handler(self, *args, **kwargs):
        """
        Init handler.
        """
        # Load environment variables from .env file
        # env_path = Path(__file__).resolve().parents[4] / ".env"
        env_path = Path("./") / ".env"
        if env_path.exists():
            load_dotenv(env_path)
            logger.debug(f"Loaded environment variables from {env_path}")
        else:
            logger.debug(
                f".env file not found at {env_path}, "
                "using existing environment variables",
            )

        session_dir = str(
            (self.workspace_dir if self.workspace_dir else WORKING_DIR)
            / "sessions",
        )
        self.session = SafeJSONSession(save_dir=session_dir)

    async def shutdown_handler(self, *args, **kwargs):
        """
        Shutdown handler.
        """
