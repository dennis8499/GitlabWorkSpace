"""Permanent static regression checks for discovery language and routing rules."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / ".agents" / "skills"


def require(text: str, *phrases: str) -> None:
    missing = [phrase for phrase in phrases if phrase not in text]
    if missing:
        raise AssertionError(f"missing contract phrases: {missing}")


def main() -> int:
    entry = (SKILLS / "megin" / "SKILL.md").read_text(encoding="utf-8")
    discovery = (SKILLS / "megin-requirements-discovery" / "SKILL.md").read_text(encoding="utf-8")
    planning = (SKILLS / "megin-technical-planning" / "SKILL.md").read_text(encoding="utf-8")
    language = (SKILLS / "megin" / "references" / "language-policy.md").read_text(encoding="utf-8")
    workflow = (SKILLS / "megin" / "references" / "workflow-record.md").read_text(encoding="utf-8")
    protocol = (SKILLS / "megin" / "references" / "requirements-discovery-protocol.md").read_text(encoding="utf-8")
    group_workspace = (SKILLS / "megin" / "references" / "group-workspace.md").read_text(encoding="utf-8")
    requirements_template = (SKILLS / "megin" / "references" / "requirements-template.md").read_text(encoding="utf-8")

    require(entry, "requirements-discovery-protocol.md", "major unknown", "phase: requirements", "status: awaiting_user")
    require(entry, "approved quality contract and handoff contain only Repos requiring actual changes", "Unchanged Repos stay in the requirements master")
    require(discovery, "requirements-discovery-protocol.md", "exactly one", "Traditional Chinese", "do not claim", "ready_for_planning")
    require(planning, "requirements-discovery-protocol.md", "major unknown", "return to requirements discovery", "do not write")
    require(language, "requirements-discovery-protocol.md", "status: awaiting_user", "Traditional Chinese")
    require(workflow, "requirements_revision:", "requirements_ref:", "phase: requirements", "status: awaiting_user")
    require(protocol, "SRC-*", "CAP-*", "Q-*", "SCN-*", "ready_for_planning", "phase: planning")
    require(protocol, "完整本地 Group Scope", "每個 Repo 須有", "讀取失敗不可推定為無需改動")
    require(group_workspace, "全 Repo Scope", "每個有效 Repo", "不詢問要選哪個 Repo", "不加入 `workflow.repositories`")
    require(group_workspace, "每個 Work ID 的 `workflow.repositories`", "核准品質契約與 handoff 只列需要實際變更", "無需改動的 Repo 保留在 requirements 全 Repo 清單", "不建立 feature branch、提交或 handoff 項目")
    require(requirements_template, "Group 全 Repo Scope", "需要改動", "無需改動", "待查證", "分支／HEAD", "方向比較與推薦")
    require(requirements_template, "核准品質契約與 handoff 只列需要實際變更並交付", "無需改動的 Repo 保留在本表", "不加入 delivery set")
    if "ask which Repo" in entry or "selection is missing or ambiguous" in discovery:
        raise AssertionError("requirements routing still asks the user to select a Repo")

    feature = (ROOT / "docs" / "work" / "work-20260922-research-driven-discovery" / "features" / "requirements-discovery.feature").read_text(encoding="utf-8")
    for scenario_id in (f"REQ-DISC-{index:03d}" for index in range(1, 12)):
        if feature.count(f"@{scenario_id}") != 1:
            raise AssertionError(f"feature scenario ID is not unique: {scenario_id}")
    print("discovery rule regression tests passed: language, routing, protocol, workflow, and scenario contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
