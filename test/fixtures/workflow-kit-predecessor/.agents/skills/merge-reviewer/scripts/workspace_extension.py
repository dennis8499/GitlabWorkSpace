"""GitLab Workspace adapters for the portable Merge Reviewer core."""

from __future__ import annotations

import argparse
from pathlib import Path

import group_review
import mr_contract


def extend_parser(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--group-root",
        help="Review all direct-child Repos' staged and working files locally with --quick.",
    )
    mr_context = parser.add_mutually_exclusive_group()
    mr_context.add_argument("--mr-context", help="Read a MergeReviewTask/v1 JSON file.")
    mr_context.add_argument(
        "--mr-context-base64", help="Read a base64-encoded MergeReviewTask/v1 JSON value."
    )


def prepare_manifest(args, api):
    if getattr(args, "group_root", None):
        return group_review.build(args, api)
    if getattr(args, "mr_context", None) or getattr(args, "mr_context_base64", None):
        mr_contract.prepare(args, api)
    return None


def publish_group(context: Path, draft: dict, manifest: dict, report_dir, include_json):
    if manifest.get("schema") != "merge-reviewer-group-context/v1":
        return None
    return group_review.publish(context, draft, manifest, report_dir, include_json)


def adapt_report(markdown: str, manifest: dict, result: dict) -> str:
    if not manifest.get("mr_context"):
        return markdown
    body = mr_contract.normalize_body(markdown)
    markdown, metadata = mr_contract.bind_report(body, manifest, result)
    result.update(report_metadata=metadata, report_body=body)
    return markdown
