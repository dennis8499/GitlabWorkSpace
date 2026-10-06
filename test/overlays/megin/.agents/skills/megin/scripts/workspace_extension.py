"""Group-mode adapter shipped by GitLab Workspace alongside the Megin core."""

from __future__ import annotations

import argparse
from pathlib import Path

import group_quality_gate


def quality_actions(core_actions: tuple[str, ...]) -> tuple[str, ...]:
    return (*core_actions, "validate-record")


def extend_quality_parser(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--group-root", type=Path)


def run_quality_action(args):
    root = group_quality_gate.validate_group_root(args.group_root)
    if args.action == "snapshot":
        return group_quality_gate.group_snapshot(root, args.work_id)
    if args.action == "validate-record":
        return group_quality_gate.validate_record_group(root, args.work_id)
    return group_quality_gate.check_group(root, args.work_id, args.gate)
