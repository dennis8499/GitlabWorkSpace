"""GitLab Workspace adapters for the portable Merge Reviewer core."""

from __future__ import annotations

import argparse
from pathlib import Path

import group_review
import mr_contract


def extend_parser(parser: argparse.ArgumentParser) -> None:
    # Group/local modes now belong to the portable core. Keep older native parsers compatible.
    for flag, help_text in (("--group-root", "Local Group root."),
                            ("--supporting-sources", "Legacy Group supplemental fixed sources."),
                            ("--megin-receipt", "Optional immutable Megin delivery receipt.")):
        if flag not in parser._option_string_actions:
            parser.add_argument(flag, help=help_text)
    mr_context = parser.add_mutually_exclusive_group()
    mr_context.add_argument("--mr-context", help="Read a MergeReviewTask/v1 JSON file.")
    mr_context.add_argument(
        "--mr-context-base64", help="Read a base64-encoded MergeReviewTask/v1 JSON value."
    )


def prepare_manifest(args, api):
    if getattr(args, "scope", None) or getattr(args, "target", None):
        return None  # Portable core prepares and validates the feature-chain context.
    if getattr(args, "group_root", None):
        if getattr(args, "megin_receipt", None):
            raise ValueError("--megin-receipt requires a fixed MR task, not Group quick")
        return group_review.build(args, api)
    if getattr(args, 'supporting_sources', None):
        raise ValueError('--supporting-sources requires Group quick review')
    if getattr(args, "mr_context", None) or getattr(args, "mr_context_base64", None):
        mr_contract.prepare(args, api)
        if getattr(args, 'megin_receipt', None):
            import json
            from group_delivery_binding import bind_delivery
            receipt = json.loads(Path(args.megin_receipt).read_text(encoding='utf-8'))
            if receipt.get('schema') == 'megin-delivery-receipt/v1':
                args.megin_binding = bind_delivery(receipt,args.mr_task)
    return None


def verify_binding(manifest):
    binding = manifest.get('megin_binding')
    if not isinstance(binding, dict) or binding.get('schema') not in ('megin-mr-binding/v1', 'megin-mr-binding/v2'):
        return False
    from group_delivery_binding import verify_report_binding
    task = mr_contract.validate_task(manifest.get('mr_context'))
    verify_report_binding(binding, {**task, 'megin_binding': binding}, task['sourceSha'], task['targetSha'], task=task)
    if (manifest.get('head_sha'), manifest.get('base_sha')) != (task['sourceSha'], task['targetSha']):
        raise ValueError('Megin MR binding differs from captured refs')
    return True


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
