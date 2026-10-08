from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PACKAGE = "gitlab-workspace-kit"
BUNDLE_SCHEMA = "gitlab-workspace-kit/v1"
INDEX_SCHEMA = "gitlab-workspace-kit-bundle/v1"
VERSION = "0.13.2"
WORKSPACE_CONTRACT = 2
ARCHIVE_LIMIT = 80 * 1024 * 1024
EXPANDED_LIMIT = 400 * 1024 * 1024
FILE_LIMIT = 64 * 1024 * 1024
COUNT_LIMIT = 12_000
ROOT = "workflow-kit"
MARKER = ".gitlab-workspace/tool-manifests/workflow-kit.json"
GROUP_LOCK = ".megin/workspace.lock.json"
INSTALL_LOCK = ".workflow-kit-install.lock"
BEGIN = "<!-- gitlab-workspace-kit:managed:start -->"
END = "<!-- gitlab-workspace-kit:managed:end -->"
WIKI_BEGIN = "<!-- codebase-wiki:managed:start -->"
WIKI_END = "<!-- codebase-wiki:managed:end -->"
LEGACY_MARKERS = (
    ".gitlab-workspace/tool-manifests/codebase-wiki.json",
    ".gitlab-workspace/tool-manifests/megin.json",
    ".gitlab-workspace/tool-manifests/merge-reviewer.json",
)
UPSTREAM = {
    "codebase-wiki": {"repository": "code-base-llm-wiki", "asset": "codebase-llm-wiki-codex.zip", "version": "0.4.0", "sha256": "6b29e9135d4f504a336d7fdc90227039b9b6866a12f503913020c3fd722197f0", "root": "codebase-llm-wiki-codex-0.4.0"},
    "megin": {"repository": "Megin", "asset": "megin-skills.zip", "version": "0.4.0", "sha256": "fb52888a5abc5a73076f50c05df9ee5caa87ec9c941c337a3dae3fd26af3df92", "root": ""},
    "merge-reviewer": {"repository": "MergeReviewer", "asset": "merge-reviewer-0.7.0.zip", "version": "0.7.0", "sha256": "0ccc6b47b4e75d5f3c1fe5a02134916362ad2e052e0e6063b732734a65a7dbd3", "root": ""},
}
PROFILE_HASHES = {
    "profile.md": "4ecc186f14ef5a2cb206eb0e99371995a7c11539ca76ddf3d94da197f2c3ade3",
    "group-instructions.md": "3641177df6c3755a8199457f3325fdc31f1d9927d285f662753dae86b1f6aa68",
    "legacy-cleanup.md": "94cf39440fa211f72036c524ecdc56a36df971ef2cdc6e4deefb9768fa9ad29a",
}
SOURCE_SUMMARY = [
    "Native Codebase LLM Wiki 0.4.0 is single-codebase; GitlabWorkSpace overlay restores Group-relative specifications and shared-Wiki rules.",
    "Native Megin 0.4.0 is single-Repo; GitlabWorkSpace overlay restores Group records, cross-Repo workflow, locks, and gitlab_mr delivery.",
    "Native MergeReviewer 0.7.0 is single-Repo/ref; GitlabWorkSpace overlay adds Group quick review and fixed-SHA Merge Request review.",
]
OVERLAY_HASHES = {'codebase-wiki': '88d89bbc04d47320ddf7230cdc6e493310b5316513a09ed4ca7f6dc8a1618d87',
 'megin': '0b7a3061d1dec8f347bf1dcf42c02ef9c50504354d86bf0bc76ca7bb497d883e',
 'merge-reviewer': 'd8bd99b91e7df8c7b44f48a1ba4c8fc8a6f36fc81158b9b62fe75b7a8bce34dc'}
CURRENT_PAYLOAD_SHA256 = '700bbd3cd4fabc3513a2874a934377f4fd0591e7e0276c905398fc4a6a548029'
CURRENT_SKILL_FILES = {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
 '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
 '.agents/skills/megin-bug-diagnosis/SKILL.md': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
 '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
 '.agents/skills/megin-code-review/SKILL.md': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
 '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
 '.agents/skills/megin-finishing-delivery/SKILL.md': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
 '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
 '.agents/skills/megin-human-acceptance/SKILL.md': '4ce75e7f4d0eb9d89cbd2a6d0307e45def505afa15e564a49c4bfb4e3b77167f',
 '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
 '.agents/skills/megin-implementation-execution/SKILL.md': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
 '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
 '.agents/skills/megin-project-knowledge/SKILL.md': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
 '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
 '.agents/skills/megin-requirements-discovery/SKILL.md': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
 '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
 '.agents/skills/megin-technical-planning/SKILL.md': '35bc74ab0bd40d29569e603e36a564cb9ad381ccd189a9629ee297f69f45cf5c',
 '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
 '.agents/skills/megin-test-driven-development/SKILL.md': '68c8dc337fc99bd122bb5c269c88a366162e82a5491067b00c2c9196efadfe19',
 '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
 '.agents/skills/megin-verification-before-completion/SKILL.md': '31e6bd6f3fc1ac28518c640f5000f7b2b1fe7f453e782d9f23945309868fa262',
 '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
 '.agents/skills/megin/SKILL.md': '6391df9e3569ba2e75ba1f40d6d51fd8fb45efa38f8e3462f7c53ac798c1f7d0',
 '.agents/skills/megin/agents/openai.yaml': 'e83f14a0b245b81ada931689895269562510490fda4362df8e6ce56cec906ceb',
 '.agents/skills/megin/references/branch-policy.md': '037f783c8cc856b68aae2eae657c12268aab10c4ba97235f44514445e1afc19b',
 '.agents/skills/megin/references/cross-flow-delivery.md': '69861d9f5093d28c3f4a382ab20eca39a21673b71bb40fb72165cb5c893d6f04',
 '.agents/skills/megin/references/cross-repo-evidence.md': 'f2a21fc6c4a82515a8fec92bf65f77e60106a80a06a7d05e9b8b95097b276372',
 '.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
 '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
 '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
 '.agents/skills/megin/references/quality-gates.md': '8e06ec220202dc147cde218530da1d61473c2ae18bd2e6b9aa16f8d5fd73b916',
 '.agents/skills/megin/references/repository-workflow.md': '5fd4e868756ee7c94833edd6d74d213a130186a86f08d1615caa4711452ad092',
 '.agents/skills/megin/references/requirements-discovery-protocol.md': '6bb694f70a9e834d6966233304dfdd07de0521207d102feef170c92b0db84df6',
 '.agents/skills/megin/references/requirements-template.md': '9cb21e1ea2f1776ee3bd3d0d677e51838c9279d8db93d2c781d61e2d0ca21061',
 '.agents/skills/megin/references/workflow-record.md': '8d608def9b186ca5de11a74394df121cb34af08633dd8a8c55fa3e762b07be2e',
 '.agents/skills/megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
 '.agents/skills/megin/scripts/delivery_receipt.py': '661cecae50a14a41d90c9163b0e453864653acb0272ee8ef3b9f2a0088046a4c',
 '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
 '.agents/skills/megin/scripts/group_quality_gate.py': '39c26dd61db692ca21b1a2202c15380ed729d21f7cb694e98dd82ee97b3b7e21',
 '.agents/skills/megin/scripts/group_workspace.py': 'b2147acc1f08215eb27fa6db1e3bfd95d111ca30c5c3a3fae0e83026428a5e58',
 '.agents/skills/megin/scripts/quality_gate.py': 'a5d9c43b679fe8d04d9b918166282fbbc66b6190a72309706a62de9bafcc3378',
 '.agents/skills/megin/scripts/repo_workspace.py': 'c757393d71231c5696dbe27a0847e6c696ef90c045aca555c764334f601c8f3b',
 '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
 '.agents/skills/megin/scripts/validate_skills.py': '60e1ae420eb79e1a547cecd63a267851669cf838aae794563fa9e4ee0874616e',
 '.agents/skills/megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
 '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b',
 '.agents/skills/merge-reviewer/SKILL.md': '090e68cad120c988cfddb48a44ae5372c85d31b8891b2fc911366f18b77c47fd',
 '.agents/skills/merge-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
 '.agents/skills/merge-reviewer/agents/openai.yaml': 'c7351c91341da5cca4a60c0df69451c389a53dcd2f8977c134e493291fb39f45',
 '.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
 '.agents/skills/merge-reviewer/references/mr-contract.md': 'bd435317c2d83926b42a3e9322c6749dc32c5477fb934639eb1fa7074bfb8849',
 '.agents/skills/merge-reviewer/references/native-review.md': '34958c9843041b806e512f95ca455b29130c8953a860dd379e1d2b7051994597',
 '.agents/skills/merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
 '.agents/skills/merge-reviewer/scripts/delivery_binding.py': 'ec17398cf4df3d44352cf39cc74afc277158d5ba342f3a00082f8414f7ab485e',
 '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'd07a606b0a1ad1664923e8758cd320665ee53cbb213c6357305aa3adbfda9f1b',
 '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
 '.agents/skills/merge-reviewer/scripts/mr_contract.py': 'fe61b1a80ef4e7a201fe3b6df28092dbd6daaa77370a2958c0054005514750fd',
 '.agents/skills/merge-reviewer/scripts/review_report.py': 'd4912998f5dd444df86ef43488169f8b1f4343e9f62d448c9fbbd741ba1f63de',
 '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
 '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'}
TRUSTED_PREDECESSORS = {'local_updates': [{'baseline_manifest_sha256': '491f28c1974def51df4c44351e1603cbbf7ca1c7f776ddc9b0b00276beacd0b6',
                    'files': {'megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                              'megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                              'megin-bug-diagnosis/SKILL.md': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                              'megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                              'megin-code-review/SKILL.md': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                              'megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                              'megin-finishing-delivery/SKILL.md': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                              'megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                              'megin-human-acceptance/SKILL.md': '4ce75e7f4d0eb9d89cbd2a6d0307e45def505afa15e564a49c4bfb4e3b77167f',
                              'megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                              'megin-implementation-execution/SKILL.md': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                              'megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                              'megin-project-knowledge/SKILL.md': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                              'megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                              'megin-requirements-discovery/SKILL.md': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                              'megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                              'megin-technical-planning/SKILL.md': '35bc74ab0bd40d29569e603e36a564cb9ad381ccd189a9629ee297f69f45cf5c',
                              'megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                              'megin-test-driven-development/SKILL.md': '68c8dc337fc99bd122bb5c269c88a366162e82a5491067b00c2c9196efadfe19',
                              'megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                              'megin-verification-before-completion/SKILL.md': '31e6bd6f3fc1ac28518c640f5000f7b2b1fe7f453e782d9f23945309868fa262',
                              'megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                              'megin/SKILL.md': '6391df9e3569ba2e75ba1f40d6d51fd8fb45efa38f8e3462f7c53ac798c1f7d0',
                              'megin/agents/openai.yaml': 'e83f14a0b245b81ada931689895269562510490fda4362df8e6ce56cec906ceb',
                              'megin/references/branch-policy.md': '037f783c8cc856b68aae2eae657c12268aab10c4ba97235f44514445e1afc19b',
                              'megin/references/cross-flow-delivery.md': '69861d9f5093d28c3f4a382ab20eca39a21673b71bb40fb72165cb5c893d6f04',
                              'megin/references/cross-repo-evidence.md': 'f2a21fc6c4a82515a8fec92bf65f77e60106a80a06a7d05e9b8b95097b276372',
                              'megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                              'megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                              'megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                              'megin/references/quality-gates.md': '8e06ec220202dc147cde218530da1d61473c2ae18bd2e6b9aa16f8d5fd73b916',
                              'megin/references/repository-workflow.md': '5fd4e868756ee7c94833edd6d74d213a130186a86f08d1615caa4711452ad092',
                              'megin/references/requirements-discovery-protocol.md': '6bb694f70a9e834d6966233304dfdd07de0521207d102feef170c92b0db84df6',
                              'megin/references/requirements-template.md': '9cb21e1ea2f1776ee3bd3d0d677e51838c9279d8db93d2c781d61e2d0ca21061',
                              'megin/references/workflow-record.md': '8d608def9b186ca5de11a74394df121cb34af08633dd8a8c55fa3e762b07be2e',
                              'megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                              'megin/scripts/delivery_receipt.py': '661cecae50a14a41d90c9163b0e453864653acb0272ee8ef3b9f2a0088046a4c',
                              'megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                              'megin/scripts/group_quality_gate.py': '39c26dd61db692ca21b1a2202c15380ed729d21f7cb694e98dd82ee97b3b7e21',
                              'megin/scripts/group_workspace.py': 'b2147acc1f08215eb27fa6db1e3bfd95d111ca30c5c3a3fae0e83026428a5e58',
                              'megin/scripts/quality_gate.py': 'a5d9c43b679fe8d04d9b918166282fbbc66b6190a72309706a62de9bafcc3378',
                              'megin/scripts/repo_workspace.py': 'c757393d71231c5696dbe27a0847e6c696ef90c045aca555c764334f601c8f3b',
                              'megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                              'megin/scripts/validate_skills.py': '60e1ae420eb79e1a547cecd63a267851669cf838aae794563fa9e4ee0874616e',
                              'megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                              'megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b',
                              'merge-reviewer/SKILL.md': '090e68cad120c988cfddb48a44ae5372c85d31b8891b2fc911366f18b77c47fd',
                              'merge-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                              'merge-reviewer/agents/openai.yaml': 'c7351c91341da5cca4a60c0df69451c389a53dcd2f8977c134e493291fb39f45',
                              'merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                              'merge-reviewer/references/mr-contract.md': 'bd435317c2d83926b42a3e9322c6749dc32c5477fb934639eb1fa7074bfb8849',
                              'merge-reviewer/references/native-review.md': '34958c9843041b806e512f95ca455b29130c8953a860dd379e1d2b7051994597',
                              'merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
                              'merge-reviewer/scripts/delivery_binding.py': 'ec17398cf4df3d44352cf39cc74afc277158d5ba342f3a00082f8414f7ab485e',
                              'merge-reviewer/scripts/git_review_context.py': 'd07a606b0a1ad1664923e8758cd320665ee53cbb213c6357305aa3adbfda9f1b',
                              'merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                              'merge-reviewer/scripts/mr_contract.py': 'fe61b1a80ef4e7a201fe3b6df28092dbd6daaa77370a2958c0054005514750fd',
                              'merge-reviewer/scripts/review_report.py': 'd4912998f5dd444df86ef43488169f8b1f4343e9f62d448c9fbbd741ba1f63de',
                              'merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                              'merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
                    'payload_sha256': '30c91f9b63d037ec8b43601ceabb35eee1e43112825e8262147ed9c4c16212af',
                    'version': '0.13.2+delivery-evidence.1'}],
 'packages': [{'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '868c6448c280217ae6936cbef6e04cbf593bfab9fd223c02f832878310852d85',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'a2fd50902b42b6883e70fd66996be923af23ad5cb4bbf1fd170429578cd1a2d3',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': '68c8dc337fc99bd122bb5c269c88a366162e82a5491067b00c2c9196efadfe19',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '31e6bd6f3fc1ac28518c640f5000f7b2b1fe7f453e782d9f23945309868fa262',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '6391df9e3569ba2e75ba1f40d6d51fd8fb45efa38f8e3462f7c53ac798c1f7d0',
                         '.agents/skills/megin/agents/openai.yaml': 'e83f14a0b245b81ada931689895269562510490fda4362df8e6ce56cec906ceb',
                         '.agents/skills/megin/references/branch-policy.md': '037f783c8cc856b68aae2eae657c12268aab10c4ba97235f44514445e1afc19b',
                         '.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                         '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/quality-gates.md': '8e06ec220202dc147cde218530da1d61473c2ae18bd2e6b9aa16f8d5fd73b916',
                         '.agents/skills/megin/references/repository-workflow.md': '5fd4e868756ee7c94833edd6d74d213a130186a86f08d1615caa4711452ad092',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': '6bb694f70a9e834d6966233304dfdd07de0521207d102feef170c92b0db84df6',
                         '.agents/skills/megin/references/requirements-template.md': '9cb21e1ea2f1776ee3bd3d0d677e51838c9279d8db93d2c781d61e2d0ca21061',
                         '.agents/skills/megin/references/workflow-record.md': '8d608def9b186ca5de11a74394df121cb34af08633dd8a8c55fa3e762b07be2e',
                         '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'f0796c5eb835d520b02e964c9b517254f4b3871318d6f253e050acaa96130229',
                         '.agents/skills/megin/scripts/group_workspace.py': '60a5ab61d3d499ba28ca5bfa9665911b3645368221cf72f9da82a42e9c50c098',
                         '.agents/skills/megin/scripts/quality_gate.py': 'a5d9c43b679fe8d04d9b918166282fbbc66b6190a72309706a62de9bafcc3378',
                         '.agents/skills/megin/scripts/repo_workspace.py': 'c757393d71231c5696dbe27a0847e6c696ef90c045aca555c764334f601c8f3b',
                         '.agents/skills/megin/scripts/validate_skills.py': '60e1ae420eb79e1a547cecd63a267851669cf838aae794563fa9e4ee0874616e',
                         '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b',
                         '.agents/skills/merge-reviewer/SKILL.md': '127139e3694c8d334ec25ac645dfca8df5e007d4bb41632127152fd83c8c3fdd',
                         '.agents/skills/merge-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'c7351c91341da5cca4a60c0df69451c389a53dcd2f8977c134e493291fb39f45',
                         '.agents/skills/merge-reviewer/references/group-review.md': '1761a877021c3a6dafc0d534d8d0853b0446b7ecba3056601add82dded98aea9',
                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'b5c66d9ebf9a84e8a2f2d7e03deb81a36099dda27a150a9fcc0062b40200684a',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '9ce0a525b58ad0693ab7e39e6de821d5a87c2876972b7a8472af0236b303ab10',
                         '.agents/skills/merge-reviewer/scripts/group_review.py': '49e973aa3083b176250b6ec771d83e6a1d525d5eb16cdc65afb5ecdb7eda970b',
                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': '91d45cf471fbb760e54f8ed66ce06da28f987440ab885a6e2e14a1eaa187ca65',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'd4912998f5dd444df86ef43488169f8b1f4343e9f62d448c9fbbd741ba1f63de',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '15d3310bbeaf47d67165f9fbe9a99c13f771895089f542b426e31de2a1142884'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                                                                                                     'upstream_sha256': '654b4bd8444eaa36b96e49eb498b6c37ce0b6b65ba1d4a48cb2a9c11992e5e85'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                                                                                                                                'upstream_sha256': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                                                                                                                                    'upstream_sha256': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                                                                                                                                 'upstream_sha256': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994'}}},
                            'megin': {'added': {'.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                                                '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                                                '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                                                '.agents/skills/megin/scripts/group_quality_gate.py': 'f0796c5eb835d520b02e964c9b517254f4b3871318d6f253e050acaa96130229',
                                                '.agents/skills/megin/scripts/group_workspace.py': '60a5ab61d3d499ba28ca5bfa9665911b3645368221cf72f9da82a42e9c50c098',
                                                '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b'},
                                      'replaced': {'.agents/skills/megin-behavior-contract/SKILL.md': {'overlay_sha256': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                                                                                                       'upstream_sha256': '02aa0daad3fb3b8442c3bf6c8be10b394f25c493a9ab6a372842a1a59ec9c721'},
                                                   '.agents/skills/megin-bug-diagnosis/SKILL.md': {'overlay_sha256': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                                                                                                   'upstream_sha256': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac'},
                                                   '.agents/skills/megin-code-review/SKILL.md': {'overlay_sha256': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                                                                                                 'upstream_sha256': '900b19674c59db08c39c6e8689616009354df060c45daab717fd7c4f196444f1'},
                                                   '.agents/skills/megin-finishing-delivery/SKILL.md': {'overlay_sha256': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                                                                                                        'upstream_sha256': 'ba37595ff65c8f696a17262532314337669cd3c5d9a1bd80d7ca90948d145629'},
                                                   '.agents/skills/megin-human-acceptance/SKILL.md': {'overlay_sha256': '868c6448c280217ae6936cbef6e04cbf593bfab9fd223c02f832878310852d85',
                                                                                                      'upstream_sha256': 'f91be08047b952131f20b0b08b1dfd370876ffe610601c4bb35ef652aa38eebe'},
                                                   '.agents/skills/megin-implementation-execution/SKILL.md': {'overlay_sha256': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                                                                                                              'upstream_sha256': 'bd5d20009f6f9575364ea81dbd46da032beb19effce79137cc3acdb07c861f8a'},
                                                   '.agents/skills/megin-project-knowledge/SKILL.md': {'overlay_sha256': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                                                                                                       'upstream_sha256': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1'},
                                                   '.agents/skills/megin-requirements-discovery/SKILL.md': {'overlay_sha256': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                                                                                                            'upstream_sha256': '76eb90a15cdedc70fa6283b7082444c65e08241caa8b29c58efa9cca6d43f589'},
                                                   '.agents/skills/megin-technical-planning/SKILL.md': {'overlay_sha256': 'a2fd50902b42b6883e70fd66996be923af23ad5cb4bbf1fd170429578cd1a2d3',
                                                                                                        'upstream_sha256': 'ff55c9bdcbde00736a336c3b4456f4359b19feb09b9a3daa57dde0b6b24741f0'},
                                                   '.agents/skills/megin-test-driven-development/SKILL.md': {'overlay_sha256': '68c8dc337fc99bd122bb5c269c88a366162e82a5491067b00c2c9196efadfe19',
                                                                                                             'upstream_sha256': 'dddc871fe1654a3253d0182c285e16cb5bc83e6d7e0f729ec7033f979b0f4d15'},
                                                   '.agents/skills/megin-verification-before-completion/SKILL.md': {'overlay_sha256': '31e6bd6f3fc1ac28518c640f5000f7b2b1fe7f453e782d9f23945309868fa262',
                                                                                                                    'upstream_sha256': '69a9ddd32ea42b707b94a21c74f41b96beed53b1c98188dffe4e268996402d7e'},
                                                   '.agents/skills/megin/SKILL.md': {'overlay_sha256': '6391df9e3569ba2e75ba1f40d6d51fd8fb45efa38f8e3462f7c53ac798c1f7d0',
                                                                                     'upstream_sha256': 'c2dbfc5b17f5606eada8f86f2da942981f0461602ca1971d95cb9deda904636d'},
                                                   '.agents/skills/megin/references/branch-policy.md': {'overlay_sha256': '037f783c8cc856b68aae2eae657c12268aab10c4ba97235f44514445e1afc19b',
                                                                                                        'upstream_sha256': '9d5f0904b6c32b7131ee2f75d558b9ff78852367a0fcaeec87924eea7ae708b8'},
                                                   '.agents/skills/megin/references/language-policy.md': {'overlay_sha256': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                                                                                                          'upstream_sha256': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a'},
                                                   '.agents/skills/megin/references/quality-gates.md': {'overlay_sha256': '8e06ec220202dc147cde218530da1d61473c2ae18bd2e6b9aa16f8d5fd73b916',
                                                                                                        'upstream_sha256': 'cb194dd81a01aa1076357851e019ec11aa5c9a92c491bffeacea2feee93a3ec7'},
                                                   '.agents/skills/megin/references/requirements-discovery-protocol.md': {'overlay_sha256': '6bb694f70a9e834d6966233304dfdd07de0521207d102feef170c92b0db84df6',
                                                                                                                          'upstream_sha256': 'd75d8865cc2f4d9135c778bd201cfb240e2b613a00dfe4e4a476256bcb3ab32a'},
                                                   '.agents/skills/megin/references/requirements-template.md': {'overlay_sha256': '9cb21e1ea2f1776ee3bd3d0d677e51838c9279d8db93d2c781d61e2d0ca21061',
                                                                                                                'upstream_sha256': '4eb84aed20fc8053ac04102cc6ba0bcb875147b4cb9b282da5cea3f7c0e4e36b'},
                                                   '.agents/skills/megin/references/workflow-record.md': {'overlay_sha256': '8d608def9b186ca5de11a74394df121cb34af08633dd8a8c55fa3e762b07be2e',
                                                                                                          'upstream_sha256': '900bd5e07dd834d44e3dcad8cc4239e0e726c0a277b07b0fc8cea00633ed0b95'}}},
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/group-review.md': '1761a877021c3a6dafc0d534d8d0853b0446b7ecba3056601add82dded98aea9',
                                                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'b5c66d9ebf9a84e8a2f2d7e03deb81a36099dda27a150a9fcc0062b40200684a',
                                                         '.agents/skills/merge-reviewer/scripts/group_review.py': '49e973aa3083b176250b6ec771d83e6a1d525d5eb16cdc65afb5ecdb7eda970b',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': '91d45cf471fbb760e54f8ed66ce06da28f987440ab885a6e2e14a1eaa187ca65',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '15d3310bbeaf47d67165f9fbe9a99c13f771895089f542b426e31de2a1142884'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '127139e3694c8d334ec25ac645dfca8df5e007d4bb41632127152fd83c8c3fdd',
                                                                                                       'upstream_sha256': '7734810f9d1674eeffc8f435c2d57c261e9de3c25cf731b61634ef11c8fc374f'}}}},
               'payloadSha256': '11e66d6bf395cd0940fe2fd9c6aea4b403addde44dc7f241195b6ba52f7d3978',
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6b29e9135d4f504a336d7fdc90227039b9b6866a12f503913020c3fd722197f0',
                                              'version': '0.4.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': 'fb52888a5abc5a73076f50c05df9ee5caa87ec9c941c337a3dae3fd26af3df92',
                                      'version': '0.4.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.7.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '0ccc6b47b4e75d5f3c1fe5a02134916362ad2e052e0e6063b732734a65a7dbd3',
                                               'version': '0.7.0'}},
               'version': '0.13.2'}],
 'schema': 'gitlab-workspace-kit-predecessors/v1'}
SPECIAL_RULES = {
    "sourceReferences": "Repo/path",
    "analysisIssueFlow": "draft-ready-scn-manual-issue",
    "developmentDelivery": "megin-gitlab_mr",
    "mergeRequestReview": "pinned-source-and-target-shas",
    "wikiFeedback": "manual-after-all-local-repo-commits",
}


class KitError(Exception):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def fail(message: str) -> None:
    raise KitError(message)


def safe_relative(raw: str) -> PurePosixPath:
    if not raw or "\\" in raw or "\x00" in raw:
        fail("組合包路徑無效。")
    relative = PurePosixPath(raw)
    if relative.is_absolute() or relative.as_posix() != raw or not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        fail("組合包路徑超出允許範圍。")
    if any(part[-1:] in (".", " ") or any(character in part for character in '<>:"|?*') for part in relative.parts):
        fail("組合包包含 Windows 不支援的檔名。")
    if any(re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.IGNORECASE) for part in relative.parts):
        fail("組合包包含 Windows 保留檔名。")
    return relative


def checked_root(value: Path) -> Path:
    try:
        root = value.resolve(strict=True)
    except OSError as error:
        fail(f"Group 工作目錄無法讀取：{error}")
    if not root.is_dir() or (root / ".git").exists():
        fail("請選擇有效的非 Git Group 工作目錄。")
    for parent in root.parents:
        if (parent / ".git").exists():
            fail("Group 工作目錄位於 Git repository 內；請從非 Git Group 根目錄使用工作流程套件。")
    return root


def assert_safe(root: Path, relative: str | PurePosixPath, *, allow_missing: bool = False) -> Path:
    root = root.resolve()
    candidate = root.joinpath(*PurePosixPath(relative).parts)
    try:
        canonical = candidate.resolve(strict=False)
        canonical.relative_to(root)
    except (OSError, ValueError):
        fail("管理路徑超出 Group 工作目錄。")
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                break
            continue
        if stat.S_ISLNK(info.st_mode) or _is_reparse_point(current, info):
            fail(f"管理路徑含有 symbolic link 或 junction：{PurePosixPath(relative).as_posix()}")
    return candidate


def _is_reparse_point(path: Path, info: os.stat_result) -> bool:
    if os.name != "nt":
        return False
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def read_regular(path: Path, max_bytes: int = 12 * 1024 * 1024) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or _is_reparse_point(path, info) or info.st_size > max_bytes:
        fail(f"檔案不是安全的一般檔案，或超過容量限制：{path.name}")
    return path.read_bytes()


def hash_tree(root: Path, path: Path) -> dict[str, str]:
    if not path.exists():
        fail(f"安裝的資料夾不存在：{path.name}")
    if not path.is_dir() or path.is_symlink() or _is_reparse_point(path, path.lstat()):
        fail(f"安裝路徑不是安全的一般資料夾：{path.name}")
    result: dict[str, str] = {}
    count = 0
    for current, dirs, files in os.walk(path, followlinks=False):
        base = Path(current)
        for name in list(dirs):
            child = base / name
            info = child.lstat()
            if stat.S_ISLNK(info.st_mode) or _is_reparse_point(child, info):
                fail("已安裝 Skill 含有 symbolic link 或 junction。")
        for name in files:
            child = base / name
            info = child.lstat()
            if not stat.S_ISREG(info.st_mode) or _is_reparse_point(child, info):
                fail("已安裝 Skill 含有 symbolic link 或特殊檔案。")
            count += 1
            if count > COUNT_LIMIT or info.st_size > FILE_LIMIT:
                fail("已安裝 Skill 超過檔案數或單檔容量限制。")
            result[child.relative_to(path).as_posix()] = digest_file(child)
    return dict(sorted(result.items()))


def extract_zip(path: Path) -> dict[str, bytes]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > ARCHIVE_LIMIT:
        fail("組合包 ZIP 不存在或超過 80 MB 限制。")
    entries: dict[str, bytes] = {}
    names: set[str] = set()
    expanded = 0
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if not members or len(members) > COUNT_LIMIT:
                fail("組合包 ZIP 檔案數量不符限制。")
            for member in members:
                relative = safe_relative(member.filename.rstrip("/"))
                key = relative.as_posix().casefold()
                if key in names:
                    fail("組合包 ZIP 含有重複路徑。")
                names.add(key)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode) or member.flag_bits & 1:
                    fail("組合包 ZIP 含有連結或加密檔案。")
                if member.is_dir():
                    continue
                if member.file_size > FILE_LIMIT or member.compress_size and member.file_size / member.compress_size > 300:
                    fail("組合包 ZIP 含有超過容量限制的檔案。")
                expanded += member.file_size
                if expanded > EXPANDED_LIMIT:
                    fail("組合包 ZIP 解壓容量超過 400 MB。")
                content = archive.read(member)
                if len(content) != member.file_size:
                    fail("組合包 ZIP 檔案長度驗證失敗。")
                entries[relative.as_posix()] = content
    except (OSError, zipfile.BadZipFile, RuntimeError, EOFError) as error:
        fail(f"組合包 ZIP 無法驗證：{error}")
    return entries


def extract_tar_xz(path: Path) -> dict[str, bytes]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > ARCHIVE_LIMIT:
        fail("VSIX 內附組合包不存在或超過 80 MB 限制。")
    entries: dict[str, bytes] = {}
    names: set[str] = set()
    expanded = 0
    try:
        with tarfile.open(path, mode="r:xz") as archive:
            for member in archive:
                relative = safe_relative(member.name)
                key = relative.as_posix().casefold()
                if key in names:
                    fail("VSIX 內附 TAR.XZ 含有重複路徑。")
                names.add(key)
                if not member.isfile() or member.issym() or member.islnk() or member.isdev() or member.isfifo() or member.size < 0:
                    fail("VSIX 內附 TAR.XZ 含有連結或特殊檔案。")
                if member.size > FILE_LIMIT:
                    fail("VSIX 內附 TAR.XZ 含有超過 64 MB 的單一檔案。")
                expanded += member.size
                if expanded > EXPANDED_LIMIT or len(entries) >= COUNT_LIMIT:
                    fail("VSIX 內附 TAR.XZ 解壓容量超過限制。")
                stream = archive.extractfile(member)
                if stream is None:
                    fail("VSIX 內附 TAR.XZ 檔案無法讀取。")
                data = stream.read(FILE_LIMIT + 1)
                if len(data) != member.size:
                    fail("VSIX 內附 TAR.XZ 檔案長度驗證失敗。")
                entries[relative.as_posix()] = data
    except (OSError, lzma.LZMAError, tarfile.TarError, EOFError) as error:
        fail(f"VSIX 內附 TAR.XZ 無法驗證：{error}")
    return entries


def parse_manifest(entries: dict[str, bytes], expected_version: str) -> tuple[dict[str, Any], dict[str, bytes]]:
    manifest_path = f"{ROOT}/manifest.json"
    raw = entries.get(manifest_path)
    if raw is None:
        fail("組合包缺少 workflow-kit manifest。")
    if len(raw) > 1024 * 1024:
        fail("組合包 manifest 超過容量限制。")
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("組合包 manifest 格式無效。")
    if not isinstance(manifest, dict) or manifest.get("schema") != BUNDLE_SCHEMA or manifest.get("package") != PACKAGE:
        fail("組合包名稱或契約版本不支援。")
    if manifest.get("version") != expected_version or expected_version != VERSION:
        fail(f"組合包版本與 GitLab Workspace {expected_version} 不相容；請下載相同版本的 VSIX 與 ZIP。")
    if manifest.get("workspaceContract") != WORKSPACE_CONTRACT:
        fail("組合包 workflow contract 與 GitLab Workspace 不相容。")
    expected_upstream = {
        key: {field: source[field] for field in ("repository", "asset", "version", "sha256")}
        for key, source in UPSTREAM.items()
    }
    if manifest.get("upstream") != expected_upstream:
        fail("組合包引用的上游 Skills 版本或 SHA-256 與此版工作台不符。")
    expected_profile = {
        "name": "GitlabWorkSpace", "knowledgeRoot": "wiki/", "specialRules": SPECIAL_RULES,
        "files": PROFILE_HASHES,
    }
    if manifest.get("customProfile") != expected_profile or manifest.get("sourceSummary") != SOURCE_SUMMARY:
        fail("組合包 Group 專用規則或來源摘要與目前工作台契約不符。")
    overlays = manifest.get("overlays")
    if not isinstance(overlays, dict) or set(overlays) != {"codebase-wiki", "megin", "merge-reviewer"}:
        fail("Declared overlay set is missing or invalid.")
    for overlay_id, overlay in overlays.items():
        overlay_digest = digest(json.dumps(overlay, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode("utf-8"))
        if overlay_digest != OVERLAY_HASHES[overlay_id]:
            fail(f"Pinned {overlay_id} overlay manifest digest does not match.")
    skill_names = manifest.get("skills")
    files = manifest.get("files")
    if not isinstance(skill_names, list) or len(skill_names) != 14 or len(set(skill_names)) != 14:
        fail("組合包未保留原有十四個 Skills。")
    if not isinstance(files, dict) or not files:
        fail("組合包缺少逐檔 SHA-256 清單。")
    payload_digest = digest(json.dumps(files, ensure_ascii=False, sort_keys=True,
                                       separators=(",", ":")).encode("utf-8"))
    if manifest.get("payloadSha256") != payload_digest:
        fail("Final payload digest does not match its manifest.")
    payload: dict[str, bytes] = {}
    prefix = f"{ROOT}/payload/"
    for name, content in entries.items():
        if name.startswith(prefix):
            relative = safe_relative(name[len(prefix):]).as_posix()
            payload[relative] = content
    if set(files) != set(payload):
        fail("組合包 payload 與 manifest 逐檔清單不一致。")
    for name, expected_digest in PROFILE_HASHES.items():
        relative = f".agents/gitlab-workspace-kit/{name}"
        if relative not in payload or digest(payload[relative]) != expected_digest or files.get(relative) != expected_digest:
            fail(f"GitLab Workspace 專用規則 SHA-256 不符：{name}")
    for relative, content in payload.items():
        if not isinstance(files.get(relative), str) or digest(content) != files[relative].lower():
            fail(f"組合包檔案 SHA-256 不符：{relative}")
    sources: dict[str, bytes] = {}
    sources_prefix = f"{ROOT}/sources/"
    for name, content in entries.items():
        if name.startswith(sources_prefix):
            relative = safe_relative(name[len(sources_prefix):]).as_posix()
            sources[relative] = content
    if set(sources) != {source["asset"] for source in UPSTREAM.values()}:
        fail("組合包缺少固定上游來源 ZIP。")
    for source in UPSTREAM.values():
        if digest(sources[source["asset"]]) != source["sha256"]:
            fail(f"上游來源 ZIP SHA-256 不符：{source['asset']}")
    expected_outer = {manifest_path} | {name for name in entries if name.startswith(f"{ROOT}/payload/") or name.startswith(f"{ROOT}/framework/") or name.startswith(f"{ROOT}/sources/")}
    if set(entries) != expected_outer:
        fail("組合包包含不允許的額外檔案。")
    framework = {name[len(f"{ROOT}/framework/"):]: content for name, content in entries.items() if name.startswith(f"{ROOT}/framework/")}
    original_wiki = _read_pinned_zip(sources[UPSTREAM["codebase-wiki"]["asset"]], UPSTREAM["codebase-wiki"])
    if framework != original_wiki:
        fail("Codebase LLM Wiki framework 內容與固定 Release ZIP 不一致。")
    _verify_upstream_payload(payload, original_wiki, sources, skill_names, overlays)
    return manifest, payload


def _read_pinned_zip(data: bytes, source: dict[str, str]) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.infolist():
                name = safe_relative(member.filename.rstrip("/"))
                if member.is_dir():
                    continue
                if not name.parts[0] == source["root"]:
                    fail("Codebase LLM Wiki 上游 ZIP 根目錄無效。")
                result[name.relative_to(PurePosixPath(source["root"])).as_posix()] = archive.read(member)
    except (zipfile.BadZipFile, RuntimeError, OSError) as error:
        fail(f"固定 Codebase LLM Wiki ZIP 無法讀取：{error}")
    return result


def _verify_upstream_payload(payload: dict[str, bytes], wiki: dict[str, bytes], sources: dict[str, bytes],
                              skill_names: list[str], overlays: dict[str, Any]) -> None:
    expected: dict[str, bytes] = {}
    for relative, content in wiki.items():
        skill = ".agents/skills/codebase-wiki/"
        if relative.startswith(skill):
            expected[relative] = content
    for source_id in ("megin", "merge-reviewer"):
        source = UPSTREAM[source_id]
        with zipfile.ZipFile(io.BytesIO(sources[source["asset"]])) as archive:
            for member in archive.infolist():
                name = safe_relative(member.filename.rstrip("/"))
                if member.is_dir():
                    continue
                if source_id == "megin":
                    if len(name.parts) < 2 or not name.parts[0].startswith("megin") or name.parts[0] == "megin-skills":
                        continue
                    destination = f".agents/skills/{name.as_posix()}"
                else:
                    if not name.as_posix().startswith("merge-reviewer/"):
                        fail("MergeReviewer archive has an unexpected root.")
                    destination = f".agents/skills/{name.as_posix()}"
                expected[destination] = archive.read(member)

    all_upstream_paths = set(expected)
    added_paths: set[str] = set()
    replaced_paths: dict[str, dict[str, str]] = {}
    for overlay_id, overlay in overlays.items():
        if not isinstance(overlay, dict) or set(overlay) != {"added", "replaced"}:
            fail(f"Invalid {overlay_id} overlay declaration.")
        added, replaced = overlay.get("added"), overlay.get("replaced")
        if not isinstance(added, dict) or not isinstance(replaced, dict):
            fail(f"Invalid {overlay_id} overlay file maps.")
        for relative, expected_digest in added.items():
            safe = safe_relative(relative).as_posix()
            if (not safe.startswith(".agents/skills/") or safe in expected or safe in added_paths
                    or not isinstance(expected_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_digest)
                    or safe not in payload or digest(payload[safe]) != expected_digest):
                fail(f"Undeclared or invalid overlay addition: {safe}")
            added_paths.add(safe)
        for relative, record in replaced.items():
            safe = safe_relative(relative).as_posix()
            if (not safe.startswith(".agents/skills/") or safe not in expected or safe in replaced_paths
                    or not isinstance(record, dict) or set(record) != {"upstream_sha256", "overlay_sha256"}
                    or digest(expected[safe]) != record.get("upstream_sha256")
                    or safe not in payload or digest(payload[safe]) != record.get("overlay_sha256")):
                fail(f"Undeclared or invalid overlay replacement: {safe}")
            replaced_paths[safe] = record

    allowed_paths = all_upstream_paths | added_paths
    actual_skill_paths = {name for name in payload if name.startswith(".agents/skills/")}
    if actual_skill_paths != allowed_paths:
        fail("Payload includes missing upstream files or undeclared overlay files.")
    for relative, original in expected.items():
        if relative not in replaced_paths and payload.get(relative) != original:
            fail(f"Undeclared upstream file difference: {relative}")

    expected_profiles = {
        ".agents/gitlab-workspace-kit/profile.md",
        ".agents/gitlab-workspace-kit/group-instructions.md",
        ".agents/gitlab-workspace-kit/legacy-cleanup.md",
    }
    expected_skill_names = sorted({PurePosixPath(name).parts[2] for name in actual_skill_paths})
    if set(payload) != expected_profiles | actual_skill_paths or not expected_profiles.issubset(payload):
        fail("Payload contains undeclared files outside the Skills and workspace profile.")
    if skill_names != expected_skill_names or len(expected_skill_names) != 14:
        fail("Skill names differ from the exact upstream and overlay composition.")
    if any(not payload.get(f".agents/skills/{name}/SKILL.md") for name in expected_skill_names):
        fail("A Skill entry point is missing.")

def import_package(archive: Path, archive_format: str, expected_version: str) -> tuple[dict[str, Any], dict[str, bytes]]:
    if not re.fullmatch(r"\d+\.\d+\.\d+", expected_version):
        fail("GitLab Workspace 版本格式無效。")
    entries = extract_zip(archive) if archive_format == "zip" else extract_tar_xz(archive)
    return parse_manifest(entries, expected_version)


class KitInstallLock:
    def __init__(self, path: Path):
        self.path = path
        self.stream: Any = None

    def __enter__(self) -> "KitInstallLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        info = self.path.lstat() if self.path.exists() or self.path.is_symlink() else None
        if info and (not stat.S_ISREG(info.st_mode) or _is_reparse_point(self.path, info)):
            fail("套件安裝鎖不是安全的一般檔案。")
        self.stream = self.path.open("a+b")
        self.stream.seek(0, os.SEEK_END)
        if self.stream.tell() == 0:
            self.stream.write(b"\0")
            self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            self.stream.close()
            self.stream = None
            fail("另一個 GitLab Workspace 套件安裝仍在執行，請稍後重試。")
        return self

    def __exit__(self, *_: object) -> None:
        if not self.stream:
            return
        with contextlib.suppress(OSError):
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        self.stream.close()


def parse_json_lines(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    fail("Codebase LLM Wiki installer 未回傳有效 JSON。")


def copy_safe_tree(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        fail(f"安裝輸入不是安全資料夾：{source.name}")
    destination.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.is_symlink() or _is_reparse_point(entry, entry.lstat()):
            fail(f"安裝輸入含有 link：{entry.name}")
        target = destination / entry.name
        if entry.is_dir():
            copy_safe_tree(entry, target)
        elif entry.is_file():
            shutil.copy2(entry, target)
        else:
            fail("安裝輸入含有特殊檔案。")


def native_wiki_preview(root: Path, stage: Path, framework: Path, has_wiki: bool) -> tuple[dict[str, Any], Path]:
    target = stage / "native-target"
    target.mkdir()
    agents = assert_safe(root, "AGENTS.md", allow_missing=True)
    if agents.exists():
        (target / "AGENTS.md").write_bytes(read_regular(agents, FILE_LIMIT))
    for relative in ("Codex.md", ".codex/config.toml", ".codex/hooks.json"):
        existing = assert_safe(root, relative, allow_missing=True)
        if existing.exists():
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(read_regular(existing, 4 * 1024 * 1024))
    old_skill = assert_safe(root, ".agents/skills/codebase-wiki", allow_missing=True)
    if old_skill.exists():
        copy_safe_tree(old_skill, target / ".agents/skills/codebase-wiki")
    installer = framework / ".agents/skills/codebase-wiki/scripts/install-framework.py"
    if not installer.is_file():
        fail("固定 Codebase LLM Wiki ZIP 缺少官方 Codex installer。")
    operation = "upgrade" if has_wiki else "install"
    command = [sys.executable, "-X", "utf8", "-B", str(installer), operation, "--target", str(target),
               "--surface", "codex", "--guard-mode", "coexist", "--format", "json"]
    preview = subprocess.run(command, cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if preview.returncode != 0:
        fail("Codebase LLM Wiki 官方預檢失敗；Group 工作區尚未變更。" + _last_detail(preview.stderr or preview.stdout))
    result = parse_json_lines(preview.stdout)
    if result.get("conflicts"):
        names = ", ".join(str(item) for item in result.get("conflicts", [])[:6])
        fail(f"Group 內既有檔案與 Wiki 安裝規則衝突，請先人工檢查：{names}")
    if result.get("guard_mode") not in (None, "coexist"):
        fail("Codebase LLM Wiki 官方預檢未採 coexist 模式。")
    return result, target


def _last_detail(text: str) -> str:
    value = text.strip().splitlines()
    return f"（{value[-1][:400]}）" if value else ""


def native_wiki_apply(target: Path, framework: Path, has_wiki: bool) -> dict[str, Any]:
    installer = framework / ".agents/skills/codebase-wiki/scripts/install-framework.py"
    operation = "upgrade" if has_wiki else "install"
    command = [sys.executable, "-X", "utf8", "-B", str(installer), operation, "--target", str(target),
               "--surface", "codex", "--guard-mode", "coexist", "--apply", "--format", "json"]
    result = subprocess.run(command, cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if result.returncode != 0:
        fail("Codebase LLM Wiki 官方安裝失敗；此 Group 套件作業已回復。" + _last_detail(result.stderr or result.stdout))
    response = parse_json_lines(result.stdout)
    if response.get("applied") is not True or response.get("guard_mode") not in (None, "coexist"):
        fail("Codebase LLM Wiki 官方 installer 未確認完整套用。")
    return response


def managed_block(text: str) -> str | None:
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        if BEGIN in text or END in text:
            fail("AGENTS.md 包含不完整或重複的 GitLab Workspace managed block。")
        return None
    start = text.index(BEGIN) + len(BEGIN)
    end = text.index(END)
    if end < start:
        fail("AGENTS.md 的 GitLab Workspace managed block 順序無效。")
    body = text[start:end]
    if body.startswith("\r\n"):
        body = body[2:]
    elif body.startswith("\n"):
        body = body[1:]
    if body.endswith("\r\n"):
        body = body[:-2]
    elif body.endswith("\n"):
        body = body[:-1]
    return body


def replace_managed_block(text: str, body: str) -> str:
    old = managed_block(text)
    replacement = f"{BEGIN}\n{body.rstrip()}\n{END}"
    if old is None:
        separator = "" if not text or text.endswith(("\n", "\r")) else "\n"
        return f"{text}{separator}{replacement}\n"
    start = text.index(BEGIN)
    end = text.index(END) + len(END)
    return f"{text[:start]}{replacement}{text[end:]}"


def trusted_skill_files(raw: dict[str, Any]) -> dict[str, str]:
    """Recognize only frozen package metadata and explicitly reviewed local overlays."""
    if (not isinstance(raw, dict) or not isinstance(raw.get("files"), dict)
            or any(not isinstance(p, str) for p in raw["files"])):
        fail("Installed package metadata is invalid.")
    upstream = {key: {k: v for k, v in value.items() if k != "root"} for key, value in UPSTREAM.items()}
    if raw.get("upstream") != upstream:
        fail("Installed upstream provenance is unknown or changed.")
    overlays = raw.get("overlays")
    if not isinstance(overlays, dict):
        fail("Installed overlay metadata is missing.")
    observed = {key: digest(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode("utf-8")) for key, value in overlays.items()}
    expected = None
    if (raw.get("version") == VERSION and raw.get("payloadSha256") == CURRENT_PAYLOAD_SHA256
            and observed == OVERLAY_HASHES and raw.get("local_update") is None):
        expected = CURRENT_SKILL_FILES
    else:
        for package in TRUSTED_PREDECESSORS["packages"]:
            if all(raw.get(key) == package.get(key) for key in ("version", "payloadSha256", "upstream", "overlays")):
                expected = package["files"]
                update = raw.get("local_update")
                if update is not None:
                    expected = None
                    for reviewed in TRUSTED_PREDECESSORS["local_updates"]:
                        if (isinstance(update, dict) and update.get("schema") == "workflow-overlay-install/v1"
                                and update.get("upstream_payload_sha256") == package["payloadSha256"]
                                and all(update.get(key) == reviewed.get(key) for key in
                                        ("version", "payload_sha256", "files", "baseline_manifest_sha256"))):
                            expected = {".agents/skills/" + p: h for p, h in reviewed["files"].items()}
                            break
                break
    if expected is None:
        fail("Installed package is not a reviewed predecessor.")
    actual = {p: h for p, h in raw.get("files", {}).items()
              if p.startswith(".agents/skills/megin") or p.startswith(".agents/skills/merge-reviewer/")}
    if actual != expected:
        fail("Installed Skill hashes differ from the reviewed package.")
    return expected


def verify_installed(root: Path, raw: dict[str, Any]) -> dict[str, Any]:
    if (not isinstance(raw, dict) or raw.get("schema") != "gitlab-workspace-kit-installed/v1" or raw.get("package") != PACKAGE
            or raw.get("workspaceContract") not in (1, WORKSPACE_CONTRACT)):
        fail("Group 組合包安裝紀錄契約無效。")
    if raw.get("workspaceContract") == WORKSPACE_CONTRACT:
        overlays = raw.get("overlays")
        if not isinstance(overlays, dict) or set(overlays) != set(OVERLAY_HASHES):
            fail("Installed overlay manifest is missing or invalid.")
        if not isinstance(raw.get("payloadSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", raw["payloadSha256"]):
            fail("Installed final payload digest is invalid.")
    trusted_skill_files(raw)
    for name, expected_hash in PROFILE_HASHES.items():
        if raw["files"].get(".agents/gitlab-workspace-kit/" + name) != expected_hash:
            fail("Installed Group profile differs from the reviewed package.")
    version = raw.get("version")
    source = raw.get("source")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version) or source not in ("gitea", "github", "bundled"):
        fail("Group 組合包安裝紀錄版本或來源無效。")
    expected = raw.get("files")
    if not isinstance(expected, dict) or not expected:
        fail("Group 組合包缺少安裝檔案摘要。")
    for relative, expected_digest in expected.items():
        safe = safe_relative(relative)
        path = assert_safe(root, safe)
        if not isinstance(expected_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_digest):
            fail("Group 組合包安裝摘要格式無效。")
        if path.is_dir():
            fail(f"套件管理檔案不應是資料夾：{relative}")
        if digest(read_regular(path, FILE_LIMIT)) != expected_digest:
            fail(f"已安裝的組合包檔案有本機修改，請先保存並檢查：{relative}")
    expected_skills = raw.get("skills")
    if (not isinstance(expected_skills, list) or len(expected_skills) != 14
            or any(not isinstance(name, str) for name in expected_skills)
            or set(expected_skills) != managed_skills()):
        fail("Group 組合包安裝記錄沒有保留十四個 Skills。")
    agent_path = assert_safe(root, "AGENTS.md", allow_missing=True)
    if agent_path.exists():
        body = managed_block(read_regular(agent_path, FILE_LIMIT).decode("utf-8"))
        if body is None or digest(body.encode("utf-8")) != raw.get("agentBlockSha256"):
            fail("AGENTS.md 的組合包管理區塊已變更，請先保存並檢查。")
    else:
        fail("Group 組合包的 AGENTS.md 管理區塊遺失。")
    wiki_state = assert_safe(root, ".agents/skills/codebase-wiki/install-state.json")
    if digest(read_regular(wiki_state)) != raw.get("wikiInstallStateSha256"):
        fail("Codebase LLM Wiki 官方安裝記錄已變更，請先檢查。")
    _verify_native_wiki_state(root, wiki_state)
    return raw


def _verify_native_wiki_state(root: Path, path: Path) -> None:
    try:
        state = json.loads(read_regular(path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Codebase LLM Wiki 官方安裝記錄格式無效。")
    files = state.get("files") if isinstance(state, dict) else None
    if not isinstance(files, dict) or state.get("guard_mode") != "coexist" or state.get("surface") != "codex":
        fail("Codebase LLM Wiki 官方安裝記錄缺少 Codex coexist surface。")
    for relative, record in files.items():
        if not isinstance(record, dict) or not isinstance(record.get("sha256"), str):
            fail("Codebase LLM Wiki 官方安裝檔案清單無效。")
        if relative == "wiki" or relative.startswith("wiki/"):
            continue
        target = assert_safe(root, safe_relative(relative))
        if record.get("kind") == "managed_block" and relative == "AGENTS.md":
            content = read_regular(target, FILE_LIMIT).decode("utf-8")
            start = content.find(WIKI_BEGIN)
            end = content.find(WIKI_END)
            if start < 0 or end < start:
                fail("Codebase LLM Wiki AGENTS.md 管理區塊遺失。")
            body = content[start + len(WIKI_BEGIN):end]
            if body.startswith("\r\n"):
                body = body[2:]
            elif body.startswith("\n"):
                body = body[1:]
            actual = digest(body.encode("utf-8"))
        else:
            actual = digest(read_regular(target))
        if actual != record["sha256"].lower():
            fail(f"Codebase LLM Wiki 安裝檔案有本機修改，請先檢查：{relative}")


def legacy_paths(root: Path, *, include_installed: bool) -> list[str]:
    found = []
    for marker in LEGACY_MARKERS:
        path = assert_safe(root, marker, allow_missing=True)
        if path.exists():
            found.append(marker)
    skills = assert_safe(root, ".agents/skills", allow_missing=True)
    if skills.is_dir():
        for child in skills.iterdir():
            name = child.name.casefold()
            if name == "gitlab-workspace-kit":
                continue
            if name == "codebase-wiki" or name == "merge-reviewer" or name.startswith("megin"):
                if child.is_symlink() or _is_reparse_point(child, child.lstat()):
                    found.append(child.relative_to(root).as_posix())
                elif include_installed:
                    found.append(child.relative_to(root).as_posix())
    agents = assert_safe(root, "AGENTS.md", allow_missing=True)
    if agents.exists() and include_installed:
        text = read_regular(agents, FILE_LIMIT).decode("utf-8", errors="replace")
        if WIKI_BEGIN in text:
            found.append("AGENTS.md: codebase-wiki:managed block")
    return sorted(set(found))


def ensure_no_legacy(root: Path, has_kit: bool) -> None:
    if root.joinpath(".gitlab-workspace/.tool-installs.lock").exists():
        fail("偵測到另一項 GitLab Workspace 工具安裝。請等候該作業結束後重試。")
    old = legacy_paths(root, include_installed=not has_kit)
    if old:
        fail("偵測到舊版分開安裝或 Skill 本機修改；請依 workflow-kit 的 legacy-cleanup.md 人工清理列出的工具檔案。請保留 wiki/、docs/work/、review-reports/、.megin/ 及其他 Skills。路徑：" + ", ".join(old[:16]))


def approved_work_in_progress(root: Path) -> list[str]:
    lock = assert_safe(root, GROUP_LOCK, allow_missing=True)
    if lock.exists():
        return [GROUP_LOCK]
    work_root = assert_safe(root, "docs/work", allow_missing=True)
    if not work_root.exists():
        return []
    if not work_root.is_dir():
        fail("docs/work 不是資料夾，無法確認 Megin 進行中的計畫。")
    blocked: list[str] = []
    candidates = sorted(work_root.iterdir(), key=lambda item: item.name)
    if len(candidates) > 5000:
        fail("docs/work 項目超過 5000 筆；請先整理工作紀錄後再更新套件。")
    for directory in candidates:
        if directory.is_symlink() or not directory.is_dir():
            continue
        workflow = directory / "workflow.md"
        if not workflow.exists():
            continue
        if workflow.is_symlink() or workflow.stat().st_size > 1024 * 1024:
            fail(f"Megin 工作紀錄無法安全檢查：docs/work/{directory.name}/workflow.md")
        text = workflow.read_text(encoding="utf-8")
        status_match = re.search(r"^\s*-\s*status:\s*([a-z_-]+)\s*$", text, re.MULTILINE | re.IGNORECASE)
        plan_match = re.search(r"^\s*-\s*plan_version:\s*['\"]?([^\s'\"]+)['\"]?\s*$", text, re.MULTILINE | re.IGNORECASE)
        status = status_match.group(1).casefold() if status_match else ""
        if status == "complete" or not plan_match:
            continue
        work_id = directory.name
        contract = directory / plan_match.group(1) / "quality-contract.json"
        if not contract.is_file() or contract.is_symlink():
            blocked.append(f"docs/work/{work_id}/workflow.md（已核准計畫）")
            continue
        try:
            value = json.loads(read_regular(contract).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            blocked.append(f"docs/work/{work_id}/workflow.md（計畫無法驗證）")
            continue
        if status != "complete" and isinstance(value, dict) and value.get("delivery_mode") == "gitlab_mr":
            blocked.append(f"docs/work/{work_id}/workflow.md（{status or '狀態未設定'}）")
    return blocked


def _safe_copy_known(source: Path, destination: Path, root: Path) -> None:
    relative = destination.relative_to(root).as_posix()
    assert_safe(root, relative, allow_missing=True)
    if source.is_symlink() or not source.is_file():
        fail(f"安裝暫存檔無效：{source.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def prepare_native_wiki(root: Path, stage: Path, entries: dict[str, bytes], has_wiki: bool) -> tuple[dict[str, Any], Path]:
    framework = stage / ROOT / "framework"
    target = stage / "native-target"
    target.mkdir()
    current_agents = assert_safe(root, "AGENTS.md", allow_missing=True)
    if current_agents.exists():
        _safe_copy_known(current_agents, target / "AGENTS.md", stage)
    for relative in ("Codex.md", ".codex/config.toml", ".codex/hooks.json"):
        current = assert_safe(root, relative, allow_missing=True)
        if current.exists():
            _safe_copy_known(current, target / relative, stage)
    current_wiki_skill = assert_safe(root, ".agents/skills/codebase-wiki", allow_missing=True)
    if current_wiki_skill.exists():
        copy_safe_tree(current_wiki_skill, target / ".agents/skills/codebase-wiki")
    installer = framework / ".agents/skills/codebase-wiki/scripts/install-framework.py"
    if not installer.is_file():
        fail("組合包缺少固定版 Codebase LLM Wiki installer。")
    action = "upgrade" if has_wiki else "install"
    command = [sys.executable, "-X", "utf8", "-B", str(installer), action, "--target", str(target),
               "--surface", "codex", "--guard-mode", "coexist", "--format", "json"]
    result = subprocess.run(command, cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        fail("Codebase LLM Wiki 官方預檢失敗；Group 尚未變更。" + (f"（{detail[-1][:400]}）" if detail else ""))
    preview = parse_json_lines(result.stdout)
    if preview.get("conflicts"):
        conflicts = ", ".join(str(item) for item in preview["conflicts"][:8])
        fail(f"Wiki 預檢發現需要先人工處理的既有檔案衝突：{conflicts}")
    if preview.get("guard_mode") not in (None, "coexist"):
        fail("Wiki 預檢未採用 coexist 模式。")
    result = subprocess.run(command + ["--apply"], cwd=target, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        fail("Codebase LLM Wiki 官方安裝失敗；組合包檔案尚未套用。" + (f"（{detail[-1][:400]}）" if detail else ""))
    applied = parse_json_lines(result.stdout)
    if applied.get("applied") is not True or applied.get("guard_mode") not in (None, "coexist"):
        fail("Codebase LLM Wiki 官方 installer 未確認完整安裝。")
    return applied, target


def _apply_wiki_overlay(candidate: Path, payload: dict[str, bytes], overlay: dict[str, Any]) -> str:
    """Apply the declared Wiki overlay after native installation and sync Wiki ownership state."""
    paths: set[str] = set()
    for key in ("added", "replaced"):
        values = overlay.get(key)
        if not isinstance(values, dict):
            fail("Wiki overlay file map is invalid.")
        paths.update(values)
    skill_prefix = ".agents/skills/codebase-wiki/"
    state_path = candidate / ".agents/skills/codebase-wiki/install-state.json"
    try:
        state = json.loads(read_regular(state_path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Wiki install state is unreadable before overlay application.")
    state_files = state.get("files") if isinstance(state, dict) else None
    if not isinstance(state_files, dict):
        fail("Wiki install state has no file map.")
    for relative in sorted(paths):
        if not relative.startswith(skill_prefix) or relative not in payload:
            fail(f"Wiki overlay file is outside the Wiki Skill or missing from payload: {relative}")
        target = candidate / safe_relative(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload[relative])
        previous = state_files.get(relative)
        kind = previous.get("kind") if isinstance(previous, dict) else "file"
        state_files[relative] = {"kind": kind if kind in ("file", "managed_block") else "file",
                                 "sha256": digest(payload[relative])}
    state_bytes = (json.dumps(state, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    state_path.write_bytes(state_bytes)
    _verify_native_wiki_state(candidate, state_path)
    return digest(state_bytes)


def _copy_extracted_payload(payload: dict[str, bytes], destination: Path) -> None:
    for relative, content in sorted(payload.items()):
        safe = safe_relative(relative)
        target = destination.joinpath(*safe.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def _copy_verified_skill(source: Path, target: Path, root: Path) -> None:
    assert_safe(root, target.relative_to(root).as_posix(), allow_missing=True)
    if source.exists():
        if source.is_symlink() or not source.is_dir():
            fail(f"Wiki installer 的 Skill 輸出不是一般資料夾：{source.name}")
        if target.exists():
            shutil.rmtree(target)
        copy_safe_tree(source, target)


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_owned(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink() or _is_reparse_point(path, path.lstat()):
        fail("回復遇到 symbolic link；已停止以保留使用者檔案。")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _restore_agent_block(root: Path, record: dict[str, Any]) -> None:
    target = assert_safe(root, "AGENTS.md", allow_missing=True)
    if not target.exists():
        if record.get("hadPrevious"):
            fail("回復時找不到原本的 AGENTS.md；暫存內容保留供檢查。")
        return
    text = read_regular(target, FILE_LIMIT).decode("utf-8")
    current = managed_block(text)
    expected = record.get("newBlock")
    old = record.get("oldBlock")
    if current is None:
        if expected is None:
            return
        fail("回復時 AGENTS.md 的 managed block 遺失。")
    if digest(current.encode("utf-8")) != record.get("newBlockSha256"):
        fail("回復遇到修改過的 AGENTS.md managed block；保留檔案與交易暫存供檢查。")
    begin = text.index(BEGIN)
    end = text.index(END) + len(END)
    if old is None:
        restored = text[:begin] + text[end:]
        if not record.get("hadPrevious") and not restored.strip():
            target.unlink()
        else:
            target.write_text(restored, encoding="utf-8", newline="")
    else:
        target.write_text(replace_managed_block(text, old), encoding="utf-8", newline="")


def _recover_transaction(root: Path, stage: Path, journal: dict[str, Any]) -> None:
    operations = journal.get("operations")
    if not isinstance(operations, list):
        fail("待回復套件交易紀錄無效；暫存檔已保留。")
    for operation in reversed(operations):
        if not isinstance(operation, dict) or operation.get("kind") not in ("path", "agent-block"):
            fail("待回復套件交易項目無效；暫存檔已保留。")
        if operation["kind"] == "agent-block":
            _restore_agent_block(root, operation)
            continue
        relative = safe_relative(str(operation.get("path", "")))
        target = assert_safe(root, relative, allow_missing=True)
        backup = assert_safe(stage, safe_relative(str(operation.get("backup", ""))), allow_missing=True)
        new_digest = operation.get("newSha256")
        had_previous = operation.get("hadPrevious") is True
        if backup.exists():
            if target.exists() and new_digest and _action_hash(target) != new_digest:
                fail(f"Recovery found a changed managed path; preserving it and the transaction files: {relative.as_posix()}")
            _remove_owned(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(backup, target)
        elif not had_previous:
            incoming = assert_safe(stage, safe_relative(str(operation.get("incoming", ""))), allow_missing=True)
            if target.exists() and not incoming.exists():
                if target.is_dir():
                    if digest_tree(target) != new_digest:
                        fail(f"回復遇到已修改的套件路徑；保留檔案：{relative.as_posix()}")
                elif digest(read_regular(target, FILE_LIMIT)) != new_digest:
                    fail(f"回復遇到已修改的套件檔案；保留檔案：{relative.as_posix()}")
                _remove_owned(target)
        elif target.exists() and operation.get("kind") == "path":
            continue
    shutil.rmtree(stage, ignore_errors=False)


def digest_tree(path: Path) -> str:
    files = hash_tree(path.parent, path)
    return digest(json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def managed_skills() -> set[str]:
    return {safe_relative(p).parts[2] for p in CURRENT_SKILL_FILES} | {"codebase-wiki"}


def transaction_paths() -> set[str]:
    return {".agents/skills/" + name for name in managed_skills()} | {
        ".agents/gitlab-workspace-kit", "Codex.md", ".codex/config.toml", ".codex/hooks.json",
        "AGENTS.md", "wiki", MARKER,
    }


def validate_pending_recovery(root: Path, stage: Path, journal: dict[str, Any]) -> None:
    """Validate every interrupted operation before restoring any managed path."""
    installed = journal.get("installed_manifest")
    if (not isinstance(installed, dict) or journal.get("payloadSha256") != installed.get("payloadSha256")
            or journal.get("phase") not in ("prepared", "applying")):
        fail("Pending transaction payload or phase differs.")
    trusted_skill_files(installed)
    if journal.get("previous_manifest") is not None:
        trusted_skill_files(journal["previous_manifest"])
    operations = journal.get("operations")
    if not isinstance(operations, list) or not operations:
        fail("Pending transaction operations missing.")
    paths, backups = set(), set()
    for operation in operations:
        if not isinstance(operation, dict) or operation.get("kind") != "path":
            fail("Invalid pending transaction operation.")
        path, backup_name = operation.get("path"), operation.get("backup")
        if (not isinstance(path, str) or safe_relative(path).as_posix() != path
                or path not in transaction_paths() or path in paths
                or not isinstance(backup_name, str) or not re.fullmatch(r"backups/[0-9]{5}", backup_name)
                or backup_name in backups or operation.get("incoming") != "incoming/" + path):
            fail("Pending transaction path or backup identity differs.")
        paths.add(path)
        backups.add(backup_name)
        if (type(operation.get("hadPrevious")) is not bool
                or operation.get("expectedPreviousPresent") != operation["hadPrevious"]):
            fail("Pending transaction before-image identity differs.")
        target = assert_safe(root, path, allow_missing=True)
        backup = assert_safe(stage, backup_name, allow_missing=True)
        incoming = assert_safe(stage, "incoming/" + path, allow_missing=True)
        if incoming.exists() and _action_hash(incoming) != operation.get("newSha256"):
            fail("Pending transaction incoming bytes changed.")
        if backup.exists():
            if not operation["hadPrevious"] or _action_hash(backup) != operation.get("expectedPreviousSha256"):
                fail("Pending transaction before-image changed.")
            if target.exists() and _action_hash(target) != operation.get("newSha256"):
                fail("Pending transaction target changed; preserving all files.")
        elif operation["hadPrevious"]:
            if not target.exists() or _action_hash(target) != operation.get("expectedPreviousSha256") or not incoming.exists():
                fail("Pending transaction original path changed or is missing.")
        elif target.exists() and (incoming.exists() or _action_hash(target) != operation.get("newSha256")):
            fail("Pending transaction new path changed; preserving all files.")
    if not (transaction_paths() - {"wiki"}).issubset(paths):
        fail("Pending transaction omits a bundle-managed path.")


def recover_incomplete(root: Path) -> None:
    stage_parent = assert_safe(root, ".gitlab-workspace/tool-installs", allow_missing=True)
    if not stage_parent.exists():
        return
    if not stage_parent.is_dir():
        fail("套件安裝暫存路徑不是資料夾。")
    for stage in sorted(stage_parent.iterdir(), key=lambda item: item.name):
        if not stage.name.startswith("kit-"):
            continue
        if stage.is_symlink() or _is_reparse_point(stage, stage.lstat()) or not stage.is_dir():
            fail("找到不安全的套件安裝暫存路徑；請人工檢查。")
        if not re.fullmatch(r"kit-[0-9a-f]{32}", stage.name):
            fail("Unrecognized transaction directory; preserving it.")
        owner = json.loads(read_regular(assert_safe(stage, "owner.json")).decode("utf-8"))
        if owner != {"package": PACKAGE, "group_root": str(root)}:
            fail("Transaction owner differs; preserving it.")
        journal_path = stage / "transaction.json"
        if not journal_path.exists():
            shutil.rmtree(stage)
            continue
        try:
            journal = json.loads(read_regular(journal_path).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("找到無法讀取的套件回復紀錄；暫存檔已保留供檢查。")
        if (journal.get("schema") != "gitlab-workspace-kit-transaction/v1" or journal.get("group_root") != str(root)
                or journal.get("id") != stage.name):
            fail("套件回復紀錄的 Group 身分不符；暫存檔已保留。")
        if journal.get("phase") == "committed":
            continue  # Completed transactions retain their verified before-images for explicit rollback.
        else:
            validate_pending_recovery(root, stage, journal)
            _recover_transaction(root, stage, journal)


def digest_payload_tree(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for current, dirs, files in os.walk(path, followlinks=False):
        base = Path(current)
        for name in list(dirs):
            child = base / name
            if child.is_symlink() or _is_reparse_point(child, child.lstat()):
                fail("套件 payload 含有 symbolic link 或 junction。")
        for name in files:
            child = base / name
            if child.is_symlink() or not child.is_file() or _is_reparse_point(child, child.lstat()):
                fail("套件 payload 含有連結或特殊檔案。")
            values[child.relative_to(path).as_posix()] = digest_file(child)
    return dict(sorted(values.items()))


def native_install_files(root: Path, staged_target: Path, has_wiki: bool) -> tuple[dict[str, bytes], str]:
    installed: dict[str, bytes] = {}
    state = staged_target / ".agents/skills/codebase-wiki/install-state.json"
    if not state.is_file():
        fail("Codebase LLM Wiki 官方安裝狀態不存在。")
    state_bytes = read_regular(state)
    _verify_native_wiki_state(staged_target, state)
    try:
        state_data = json.loads(state_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Codebase LLM Wiki 官方安裝狀態格式無效。")
    for relative in state_data["files"]:
        if relative == "wiki" or relative.startswith("wiki/"):
            continue
        source = staged_target / safe_relative(relative)
        if not source.is_file():
            fail(f"Codebase LLM Wiki installer output is missing: {relative}")
        installed[relative] = read_regular(source, FILE_LIMIT)
    installed_state_digest = digest(state_bytes)
    return installed, installed_state_digest


def _mkdir_safe(root: Path, relative: str) -> Path:
    target = assert_safe(root, relative, allow_missing=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


def _copy_candidate(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def _action_hash(path: Path) -> str:
    if path.is_dir():
        return digest_tree(path)
    return digest(read_regular(path, EXPANDED_LIMIT))


def _prepare_actions(root: Path, stage: Path, incoming: dict[str, bytes], old_manifest: dict[str, Any] | None,
                     block_old: str | None, block_new: str, installed_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    source_root = stage / "candidate"
    _copy_extracted_payload(incoming, source_root)
    wiki_input = source_root / ".agents/skills/codebase-wiki"
    for relative, content in installed_manifest["nativeFiles"].items():
        if relative.startswith(".agents/skills/codebase-wiki/"):
            suffix = relative[len(".agents/skills/codebase-wiki/"):]
            destination = wiki_input / suffix
        else:
            destination = source_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    agents_target = source_root / "AGENTS.md"
    current = agents_target.read_text(encoding="utf-8") if agents_target.is_file() else ""
    agents_target.write_text(replace_managed_block(current, block_new), encoding="utf-8", newline="")
    installed_manifest["files"] = digest_payload_tree(source_root)
    installed_manifest["agentBlockSha256"] = digest(block_new.encode("utf-8"))
    installed_manifest["wikiInstallStateSha256"] = installed_manifest["nativeWikiInstallStateSha256"]
    manifest_target = source_root / "tool-manifest.json"
    _atomic_json(manifest_target, installed_manifest)

    old_names = set(old_manifest.get("skills", [])) if old_manifest else set()
    source_skill_root = source_root / ".agents/skills"
    new_names = sorted(name for name in source_skill_root.iterdir() if name.is_dir())
    operations: list[dict[str, Any]] = []
    ordinal = 0
    for skill in new_names:
        relative = skill.relative_to(source_root).as_posix()
        destination = assert_safe(root, relative, allow_missing=True)
        had_previous = destination.exists()
        if had_previous and skill.name not in old_names:
            fail(f"Group 已有同名但不屬於組合包的 Skill；為保留使用者內容已停止：{relative}")
        backup = f"backups/{ordinal:05d}"
        incoming_name = f"incoming/{relative}"
        operations.append({"kind": "path", "path": relative, "backup": backup, "incoming": incoming_name,
                           "hadPrevious": had_previous, "newSha256": digest_tree(skill)})
        staged_in = stage / incoming_name
        staged_in.parent.mkdir(parents=True, exist_ok=True)
        os.replace(skill, staged_in)
        ordinal += 1
    for relative in (".agents/gitlab-workspace-kit", ".codex/config.toml", ".codex/hooks.json"):
        source = source_root / relative
        if not source.exists():
            continue
        destination = assert_safe(root, relative, allow_missing=True)
        had_previous = destination.exists()
        if relative == ".agents/gitlab-workspace-kit" and had_previous and not old_manifest:
            fail("Group 已有同名 GitLab Workspace profile；為保留使用者內容已停止。")
        if relative.startswith(".codex/") and had_previous and not old_manifest:
            old_native = installed_manifest["nativeOriginals"].get(relative)
            new_value = source.read_bytes()
            if old_native is not None and read_regular(destination, 4 * 1024 * 1024) != old_native:
                fail(f"GitLab Workspace profile 的 native Wiki 設定有本機修改：{relative}")
        backup = f"backups/{ordinal:05d}"
        incoming_name = f"incoming/{relative}"
        operations.append({"kind": "path", "path": relative, "backup": backup, "incoming": incoming_name,
                           "hadPrevious": had_previous, "newSha256": digest_tree(source) if source.is_dir() else digest(source.read_bytes())})
        staged_in = stage / incoming_name
        staged_in.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            os.replace(source, staged_in)
        else:
            os.replace(source, staged_in)
        ordinal += 1

    agent_source = source_root / "AGENTS.md"
    agent_dest = assert_safe(root, "AGENTS.md", allow_missing=True)
    old_agent = agent_dest.read_text(encoding="utf-8") if agent_dest.is_file() else ""
    old_body = managed_block(old_agent)
    if old_manifest:
        if old_body is None or digest(old_body.encode("utf-8")) != old_manifest.get("agentBlockSha256"):
            fail("AGENTS.md 的 GitLab Workspace block 有本機修改；請先保存並檢查。")
        block_hash = installed_manifest["agentBlockSha256"]
        new_agent = agent_source.read_text(encoding="utf-8")
        new_body = managed_block(new_agent)
        operations.append({"kind": "agent-block", "path": "AGENTS.md", "hadPrevious": True,
                           "oldBlock": old_body, "newBlock": new_body, "newBlockSha256": block_hash})
    elif old_body is not None:
        fail("AGENTS.md 已含 GitLab Workspace managed block，但套件安裝紀錄不存在。")
    else:
        new_agent = agent_source.read_text(encoding="utf-8")
        new_body = managed_block(new_agent)
        operations.append({"kind": "agent-block", "path": "AGENTS.md", "hadPrevious": agent_dest.exists(),
                           "oldBlock": None, "newBlock": new_body, "newBlockSha256": digest(new_body.encode("utf-8"))})

    manifest_relative = MARKER
    manifest_destination = assert_safe(root, manifest_relative, allow_missing=True)
    manifest_input = stage / "incoming" / manifest_relative
    manifest_input.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(manifest_target, manifest_input)
    operations.append({"kind": "path", "path": manifest_relative, "backup": f"backups/{ordinal:05d}",
                       "incoming": f"incoming/{manifest_relative}", "hadPrevious": manifest_destination.exists(),
                       "newSha256": digest(read_regular(manifest_input, FILE_LIMIT))})
    return operations


def _apply_operations(root: Path, stage: Path, operations: list[dict[str, Any]], journal_path: Path, journal: dict[str, Any]) -> None:
    journal["operations"] = operations
    journal["phase"] = "applying"
    _atomic_json(journal_path, journal)
    for count, operation in enumerate(operations, start=1):
        if operation["kind"] == "agent-block":
            target = assert_safe(root, "AGENTS.md", allow_missing=True)
            current = target.read_text(encoding="utf-8") if target.is_file() else ""
            if managed_block(current) != operation.get("oldBlock"):
                fail("AGENTS.md 在套用期間變更，請先重新執行組合包安裝。")
            result = replace_managed_block(current, operation["newBlock"])
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
            temporary.write_text(result, encoding="utf-8", newline="")
            os.replace(temporary, target)
        else:
            relative = safe_relative(operation["path"])
            target = assert_safe(root, relative, allow_missing=True)
            source = assert_safe(stage, safe_relative(operation["incoming"]))
            backup = assert_safe(stage, safe_relative(operation["backup"]), allow_missing=True)
            expected_present = operation.get("expectedPreviousPresent")
            if isinstance(expected_present, bool) and target.exists() != expected_present:
                fail(f"Install target changed after preflight; refusing to overwrite it: {relative.as_posix()}")
            expected_previous = operation.get("expectedPreviousSha256")
            if expected_previous is not None and (not target.exists() or _action_hash(target) != expected_previous):
                fail(f"Install target changed after preflight; refusing to overwrite it: {relative.as_posix()}")
            if target.exists():
                backup.parent.mkdir(parents=True, exist_ok=True)
                os.replace(target, backup)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
        _test_after_apply(count, len(operations))


def _test_after_apply(count: int, total: int) -> None:
    if os.environ.get("GITLAB_WORKSPACE_KIT_TESTING") != "1":
        return
    for variable, action in (("GITLAB_WORKSPACE_KIT_TEST_FAIL_AFTER", "fail"),
                             ("GITLAB_WORKSPACE_KIT_TEST_CRASH_AFTER", "crash")):
        requested = os.environ.get(variable)
        if not requested:
            continue
        target = total if requested == "last" else int(requested)
        if count == target:
            if action == "crash":
                os._exit(86)
            fail(f"Test injection: simulated install failure after operation {count}.")


def install(archive: Path, archive_format: str, group_root: Path, expected_version: str, source: str,
           entry_root: str, archive_sha256: str, *, dry_run: bool = False) -> dict[str, Any]:
    root = checked_root(group_root)
    if source not in ("gitea", "github", "bundled"):
        fail("組合包來源無效。")
    if archive_format not in ("zip", "tar.xz") or archive_format == "tar.xz" and entry_root != ROOT or archive_format == "zip" and entry_root not in ("", ROOT):
        fail("組合包封裝格式或根目錄無效。")
    if not re.fullmatch(r"[a-f0-9]{64}", archive_sha256) or digest_file(archive) != archive_sha256.lower():
        fail("組合包 SHA-256 與套件索引不符。")
    lock_path = assert_safe(root, INSTALL_LOCK, allow_missing=True)
    preview = tempfile.TemporaryDirectory(prefix="workflow-kit-preview-") if dry_run else None
    stage_parent = Path(preview.name) if preview else _mkdir_safe(root, ".gitlab-workspace/tool-installs")
    with contextlib.ExitStack() as resources:
        if preview:
            resources.enter_context(preview)
        else:
            resources.enter_context(KitInstallLock(lock_path))
            recover_incomplete(root)
        existing_manifest_path = assert_safe(root, MARKER, allow_missing=True)
        old_manifest: dict[str, Any] | None = None
        if existing_manifest_path.exists():
            try:
                old_manifest = json.loads(read_regular(existing_manifest_path).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail("現有 GitLab Workspace 組合包紀錄無法讀取；請先保存並檢查。")
            verify_installed(root, old_manifest)
        ensure_no_legacy(root, old_manifest is not None)
        active = approved_work_in_progress(root)
        if active:
            fail("Group 內有尚未結束的 Megin 工作；先完成或依 Megin 流程確認中止後再更新套件。路徑：" + ", ".join(active[:8]))
        wiki_path = assert_safe(root, "wiki", allow_missing=True)
        if wiki_path.exists() and not wiki_path.is_dir():
            fail("Group 的 wiki 路徑不是資料夾，無法安裝共用知識庫。")
        has_wiki = wiki_path.is_dir()
        stage = stage_parent / f"kit-{uuid.uuid4().hex}"
        stage.mkdir()
        (stage / "owner.json").write_text(json.dumps({"package": PACKAGE, "group_root": str(root)}, ensure_ascii=False), encoding="utf-8")
        journal_path = stage / "transaction.json"
        try:
            entries = extract_zip(archive) if archive_format == "zip" else extract_tar_xz(archive)
            manifest, payload = parse_manifest(entries, expected_version)
            framework_prefix = f"{ROOT}/framework/"
            framework = {name[len(framework_prefix):]: content for name, content in entries.items() if name.startswith(framework_prefix)}
            _copy_extracted_payload(framework, stage / ROOT / "framework")
            _, native_target = prepare_native_wiki(root, stage, entries, has_wiki)
            _, native_state_sha = native_install_files(root, native_target, has_wiki)
            candidate_payload = stage / "candidate" / "payload"
            _copy_extracted_payload(payload, candidate_payload)
            installed_wiki_skill = candidate_payload / ".agents/skills/codebase-wiki"
            if installed_wiki_skill.exists():
                shutil.rmtree(installed_wiki_skill)
            copy_safe_tree(native_target / ".agents/skills/codebase-wiki", installed_wiki_skill)
            native_state = json.loads(read_regular(native_target / ".agents/skills/codebase-wiki/install-state.json").decode("utf-8"))
            for relative in native_state.get("files", {}):
                if relative.startswith(".agents/skills/codebase-wiki/") or relative == "wiki" or relative.startswith("wiki/"):
                    continue
                source_path = native_target / safe_relative(relative)
                if not source_path.is_file():
                    fail(f"Codebase LLM Wiki installer output is missing: {relative}")
                target_path = candidate_payload / safe_relative(relative)
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, target_path)
            native_state_sha = _apply_wiki_overlay(
                candidate_payload, payload, manifest["overlays"]["codebase-wiki"],
            )
            if not has_wiki:
                copy_safe_tree(native_target / "wiki", candidate_payload / "wiki")
            agent_candidate = candidate_payload / "AGENTS.md"
            if not agent_candidate.exists():
                agent_candidate.parent.mkdir(parents=True, exist_ok=True)
                agent_candidate.write_text("", encoding="utf-8")
            instructions = (candidate_payload / ".agents/gitlab-workspace-kit/group-instructions.md").read_text(encoding="utf-8").strip()
            rendered = replace_managed_block(agent_candidate.read_text(encoding="utf-8"), instructions)
            agent_candidate.write_text(rendered, encoding="utf-8", newline="")
            actual_payload = digest_payload_tree(candidate_payload)
            installed_files = {
                relative: value for relative, value in actual_payload.items()
                if relative.startswith(".agents/skills/") or relative.startswith(".agents/gitlab-workspace-kit/")
            }
            skill_dirs = sorted(path.name for path in (candidate_payload / ".agents/skills").iterdir() if path.is_dir())
            if skill_dirs != sorted(manifest["skills"]):
                fail("安裝暫存中的十四個 Skills 與組合包 Manifest 不一致。")
            native_block = managed_block(rendered)
            expected_installed = {
                "schema": "gitlab-workspace-kit-installed/v1",
                "package": PACKAGE,
                "version": expected_version,
                "workspaceContract": WORKSPACE_CONTRACT,
                "source": source,
                "archiveSha256": archive_sha256.lower(),
                "upstream": manifest["upstream"],
                "overlays": manifest["overlays"],
                "payloadSha256": manifest["payloadSha256"],
                "skills": manifest["skills"],
                "files": installed_files,
                "agentBlockSha256": digest((native_block or "").encode("utf-8")),
                "wikiInstallStateSha256": native_state_sha,
            }
            manifest_target = candidate_payload / "tool-manifest.json"
            _atomic_json(manifest_target, expected_installed)
            operations = build_operations(root, stage, candidate_payload, old_manifest, expected_installed)
            changed = [o["path"] for o in operations if not o["hadPrevious"] or
                       o.get("expectedPreviousSha256") != o["newSha256"]]
            if dry_run or not changed:
                shutil.rmtree(stage)
                return {"ok": True, "package": PACKAGE, "version": expected_version,
                        "status": "ready" if changed else "unchanged", "applied": False,
                        "changed_paths": changed, "skills": len(manifest["skills"])}
            journal = {"schema": "gitlab-workspace-kit-transaction/v1", "group_root": str(root),
                       "id": stage.name, "payloadSha256": manifest["payloadSha256"],
                       "previous_manifest": old_manifest, "installed_manifest": expected_installed,
                       "phase": "prepared", "operations": operations}
            _atomic_json(journal_path, journal)
            _apply_operations(root, stage, operations, journal_path, journal)
            journal["phase"] = "committed"
            _atomic_json(journal_path, journal)
            for child in stage.iterdir():
                if child.name not in ("backups", "transaction.json", "owner.json"):
                    _remove_owned(child)
            return {"ok": True, "package": PACKAGE, "version": expected_version, "source": source,
                    "skills": len(manifest["skills"]), "wiki": "preserved" if has_wiki else "seeded",
                    "status": "installed", "applied": True, "changed_paths": changed,
                    "transaction": journal_path.relative_to(root).as_posix()}
        except Exception:
            if journal_path.is_file():
                try:
                    journal = json.loads(journal_path.read_text(encoding="utf-8"))
                    if journal.get("phase") != "committed":
                        _recover_transaction(root, stage, journal)
                except Exception as rollback_error:
                    fail(f"套件安裝已停止；回復遇到問題，請保留並檢查 {stage}：{rollback_error}")
            elif stage.exists():
                shutil.rmtree(stage, ignore_errors=True)
            raise


def rollback(group_root: Path, journal_value: Path) -> dict[str, Any]:
    root = checked_root(group_root)
    journal_path = journal_value if journal_value.is_absolute() else root / journal_value
    relative = journal_path.absolute().relative_to(root).as_posix()
    if not re.fullmatch(r"\.gitlab-workspace/tool-installs/kit-[0-9a-f]{32}/transaction\.json", relative):
        fail("Rollback requires an owned retained transaction journal.")
    journal_path = assert_safe(root, relative)
    stage = journal_path.parent
    with KitInstallLock(assert_safe(root, INSTALL_LOCK, allow_missing=True)):
        journal = json.loads(read_regular(journal_path).decode("utf-8"))
        owner = json.loads(read_regular(assert_safe(stage, "owner.json")).decode("utf-8"))
        if (owner != {"package": PACKAGE, "group_root": str(root)}
                or journal.get("schema") != "gitlab-workspace-kit-transaction/v1"
                or journal.get("group_root") != str(root) or journal.get("id") != stage.name
                or journal.get("phase") != "committed"
                or journal.get("payloadSha256") != CURRENT_PAYLOAD_SHA256):
            fail("Rollback transaction identity or reviewed payload differs.")
        if approved_work_in_progress(root):
            fail("Finish or explicitly stop active Megin work before rollback.")
        current = json.loads(read_regular(assert_safe(root, MARKER)).decode("utf-8"))
        verify_installed(root, current)
        if current != journal.get("installed_manifest"):
            fail("Installed package changed after this transaction.")
        previous = journal.get("previous_manifest")
        if previous is not None:
            trusted_skill_files(previous)
        operations = journal.get("operations")
        if not isinstance(operations, list) or not operations:
            fail("Rollback operations missing.")
        allowed = transaction_paths()
        required = allowed - {"wiki"}
        seen, backups = set(), set()
        # Validate the entire rollback, including every before-image, before changing anything.
        for operation in operations:
            if not isinstance(operation, dict) or operation.get("kind") != "path":
                fail("Invalid rollback operation.")
            path = operation.get("path")
            if not isinstance(path, str) or safe_relative(path).as_posix() != path or path not in allowed or path in seen:
                fail("Rollback path is duplicate or outside bundle ownership.")
            seen.add(path)
            backup_name = operation.get("backup", "")
            if not re.fullmatch(r"backups/[0-9]{5}", backup_name) or backup_name in backups or operation.get("incoming") != "incoming/" + path:
                fail("Rollback backup identity differs.")
            backups.add(backup_name)
            target = assert_safe(root, path)
            if _action_hash(target) != operation.get("newSha256"):
                fail("Rollback target changed; preserving it.")
            if type(operation.get("hadPrevious")) is not bool or operation.get("expectedPreviousPresent") != operation["hadPrevious"]:
                fail("Rollback before-image identity differs.")
            backup = assert_safe(stage, backup_name, allow_missing=True)
            if operation["hadPrevious"]:
                if not backup.exists() or _action_hash(backup) != operation.get("expectedPreviousSha256"):
                    fail("Rollback before-image missing or changed.")
                if path.startswith(".agents/skills/") and previous is not None:
                    actual = {path + "/" + p.removeprefix(backup.name + "/"): h
                              for p, h in hash_tree(backup.parent, backup).items()}
                    expected = {p: h for p, h in previous["files"].items() if p.startswith(path + "/")}
                    if actual != expected:
                        fail("Rollback Skill before-image differs from trusted installed files.")
                if path == MARKER and json.loads(read_regular(backup).decode("utf-8")) != previous:
                    fail("Rollback previous manifest differs.")
            elif backup.exists():
                fail("Unexpected rollback before-image.")
        if not required.issubset(seen):
            fail("Rollback operations omit a bundle-managed path.")
        _recover_transaction(root, stage, journal)
        return {"ok": True, "package": PACKAGE, "status": "rolled-back", "transaction": relative}


def build_operations(root: Path, stage: Path, payload: Path, old_manifest: dict[str, Any] | None,
                     installed: dict[str, Any]) -> list[dict[str, Any]]:
    operations: list[dict[str, Any]] = []
    old_skill_names = set(old_manifest.get("skills", [])) if old_manifest else set()
    skill_root = payload / ".agents/skills"
    new_skills = sorted(skill_root.iterdir(), key=lambda item: item.name)
    for skill in new_skills:
        if not skill.is_dir() or skill.is_symlink():
            fail("Bundle Skill path is not a regular directory.")
        relative = skill.relative_to(payload).as_posix()
        destination = assert_safe(root, relative, allow_missing=True)
        if destination.exists() and skill.name not in old_skill_names:
            fail(f"A Skill path is already owned by another tool; refusing to overwrite it: {relative}")

    current_agent = assert_safe(root, "AGENTS.md", allow_missing=True)
    current = read_regular(current_agent, FILE_LIMIT).decode("utf-8") if current_agent.exists() else ""
    old_body = managed_block(current)
    if old_manifest:
        if old_body is None or digest(old_body.encode("utf-8")) != old_manifest.get("agentBlockSha256"):
            fail("The GitLab Workspace block in AGENTS.md was changed locally.")
    elif old_body is not None:
        fail("AGENTS.md already has a GitLab Workspace block without an install record.")
    agent_source = payload / "AGENTS.md"
    new_body = managed_block(read_regular(agent_source, FILE_LIMIT).decode("utf-8"))
    if new_body is None or digest(new_body.encode("utf-8")) != installed.get("agentBlockSha256"):
        fail("The staged GitLab Workspace block does not match the install record.")

    relative_paths = [(skill.relative_to(payload).as_posix(), skill.relative_to(payload).as_posix()) for skill in new_skills]
    relative_paths += [(relative, relative) for relative in (".agents/gitlab-workspace-kit", "Codex.md", ".codex/config.toml", ".codex/hooks.json", "AGENTS.md")]
    if (payload / "wiki").exists():
        relative_paths.append(("wiki", "wiki"))
    relative_paths.append(("tool-manifest.json", MARKER))
    for ordinal, (source_relative, relative) in enumerate(relative_paths):
        source_path = payload / source_relative
        if not source_path.exists():
            continue
        destination = assert_safe(root, relative, allow_missing=True)
        bundle_owned = relative.startswith(".agents/skills/") or relative == ".agents/gitlab-workspace-kit"
        if destination.exists() and bundle_owned and not old_manifest:
            fail(f"A bundle-managed path already exists; refusing to overwrite it: {relative}")
        if relative == "wiki" and destination.exists():
            fail("Group/wiki appeared after preflight; preserving it and stopping the install.")
        incoming = f"incoming/{relative}"
        staged_input = stage / incoming
        staged_input.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source_path, staged_input)
        previous_present = destination.exists()
        operation: dict[str, Any] = {
            "kind": "path", "path": relative, "backup": f"backups/{ordinal:05d}",
            "incoming": incoming, "hadPrevious": previous_present,
            "expectedPreviousPresent": previous_present,
            "newSha256": _action_hash(staged_input),
        }
        if previous_present:
            operation["expectedPreviousSha256"] = _action_hash(destination)
        operations.append(operation)
    return operations

def _preflight_existing_workflow(root: Path) -> dict[str, Any] | None:
    marker = assert_safe(root, MARKER, allow_missing=True)
    if not marker.exists():
        return None
    try:
        raw = json.loads(read_regular(marker).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("已安裝組合包紀錄無法讀取。")
    verify_installed(root, raw)
    return raw


def inspect_status(root_value: Path, expected_version: str) -> dict[str, Any]:
    root = checked_root(root_value)
    try:
        lock_path = assert_safe(root, INSTALL_LOCK, allow_missing=True)
        with KitInstallLock(lock_path):
            recover_incomplete(root)
            raw = _preflight_existing_workflow(root)
            if raw:
                active = approved_work_in_progress(root)
                if active:
                    return {"ok": True, "status": "work-in-progress", "version": raw["version"], "source": raw["source"], "message": "請先完成 Megin 工作再更新組合包。"}
                status = "installed" if (raw["version"] == expected_version and
                    raw.get("payloadSha256") == CURRENT_PAYLOAD_SHA256 and
                    raw.get("local_update") is None) else "update-available"
                return {"ok": True, "status": status, "version": raw["version"], "source": raw["source"]}
            old = legacy_paths(root, include_installed=True)
            if old:
                return {"ok": True, "status": "needs-cleanup", "message": "請依組合包 cleanup 文件人工移除舊工具，保留 Wiki 與工作紀錄。", "legacyPaths": old[:24]}
            return {"ok": True, "status": "missing"}
    except (KitError, OSError, ValueError, TypeError) as error:
        return {"ok": True, "status": "error", "message": str(error) or "組合包安裝記錄無法驗證。"}


def run() -> int:
    parser = argparse.ArgumentParser(description="Verify and atomically install the GitLab Workspace workflow kit.")
    subcommands = parser.add_subparsers(dest="action", required=True)
    inspect_parser = subcommands.add_parser("inspect")
    inspect_parser.add_argument("archive", type=Path)
    inspect_parser.add_argument("--format", choices=("zip", "tar.xz"), required=True)
    inspect_parser.add_argument("--expected-version", required=True)
    status_parser = subcommands.add_parser("status")
    status_parser.add_argument("group_root", type=Path)
    status_parser.add_argument("--expected-version", required=True)
    install_parser = subcommands.add_parser("install")
    install_parser.add_argument("archive", type=Path)
    install_parser.add_argument("group_root", type=Path)
    install_parser.add_argument("version")
    install_parser.add_argument("source", choices=("gitea", "github", "bundled"))
    install_parser.add_argument("--format", choices=("zip", "tar.xz"), required=True)
    install_parser.add_argument("--entry-root", default="")
    install_parser.add_argument("--archive-sha256", required=True)
    install_parser.add_argument("--dry-run", action="store_true", help="Validate and preview in system temp without changing the Group.")
    rollback_parser = subcommands.add_parser("rollback")
    rollback_parser.add_argument("group_root", type=Path)
    rollback_parser.add_argument("journal", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "inspect":
            manifest, payload = import_package(args.archive, args.format, args.expected_version)
            print(json.dumps({"ok": True, "package": PACKAGE, "version": manifest["version"],
                              "workspaceContract": manifest["workspaceContract"], "sha256": digest_file(args.archive),
                              "skills": len(manifest["skills"]), "files": len(payload)}, ensure_ascii=False))
            return 0
        if args.action == "status":
            print(json.dumps(inspect_status(args.group_root, args.expected_version), ensure_ascii=False))
            return 0
        if args.action == "rollback":
            print(json.dumps(rollback(args.group_root, args.journal), ensure_ascii=False))
            return 0
        result = install(args.archive, args.format, args.group_root, args.version, args.source,
                         args.entry_root, args.archive_sha256, dry_run=args.dry_run)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (KitError, OSError, ValueError, EOFError, subprocess.SubprocessError, tarfile.TarError,
            lzma.LZMAError, zipfile.BadZipFile, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error) or "組合包安裝已安全停止。"}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
