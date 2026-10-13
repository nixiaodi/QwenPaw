from agentscope.message import Msg, TextBlock, ToolCallBlock, ToolResultBlock
from qwenpaw.agents.retrieval_evidence_guard import RetrievalEvidenceGuard
from qwenpaw.loop.gates import StopAction


def evidence(name, arguments, state="success"):
    return [
        Msg(
            name="tool",
            role="assistant",
            content=[
                ToolCallBlock(id=name, name=name, input=arguments),
                ToolResultBlock(
                    id=name, name=name, state=state, output=[TextBlock(text="result")]
                ),
            ],
        )
    ]


def test_reading_skill_or_failed_search_cannot_count_as_retrieval():
    guard = RetrievalEvidenceGuard(set())
    guard.observe(evidence("load_skill", '{"skill":"news-summary"}'))
    guard.observe(evidence("execute_shell_command", '{"command":"ls"}'))
    guard.observe(evidence("web_search", '{"search_term":"AI新闻"}', "error"))
    assert not guard.delivered
    assert (
        guard.check(
            Msg(name="assistant", role="assistant", content=[TextBlock(text="已完成新闻搜索")])
        ).action
        == StopAction.INTERRUPT_AND_CONTINUE
    )
    guard.observe(evidence("web_search", '{"search_term":"AI新闻"}'))
    assert guard.delivered


def test_search_and_requested_file_delivery_are_both_required():
    guard = RetrievalEvidenceGuard({"application/pdf"})
    guard.observe(evidence("web_search", '{"search_term":"AI新闻"}'))
    assert not guard.delivered


def test_script_help_is_not_a_real_search():
    guard = RetrievalEvidenceGuard(set())
    guard.observe(
        evidence(
            "execute_shell_command", '{"command":"python scripts/search.py --help"}'
        )
    )
    assert not guard.delivered
    guard.observe(
        evidence(
            "execute_shell_command", '{"command":"python scripts/search.py --query AI"}'
        )
    )
    assert guard.delivered
