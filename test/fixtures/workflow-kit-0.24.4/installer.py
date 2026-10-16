from __future__ import annotations

import argparse
import contextlib
import ctypes
import datetime
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
import tomllib
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PACKAGE = "gitlab-workspace-kit"
BUNDLE_SCHEMA = "gitlab-workspace-kit/v1"
INDEX_SCHEMA = "gitlab-workspace-kit-bundle/v1"
VERSION = '0.24.4'
KIT_EXTENSION_FILES = {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
 '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'}
WIKI_CONFIG_FILES = {'.codex/config.toml': '[features]\n'
                       'hooks = true\n'
                       '\n'
                       '[wiki_guard]\n'
                       '# Installed repos use "wiki-only" by default or explicit "coexist" for normal\n'
                       '# coding sessions. Use "framework" only in this framework repository.\n'
                       'mode = "coexist"\n',
 '.codex/hooks.json': '{\n'
                      '  "hooks": {\n'
                      '    "SessionStart": [\n'
                      '      {\n'
                      '        "matcher": "startup|resume|clear|compact",\n'
                      '        "hooks": [\n'
                      '          {\n'
                      '            "type": "command",\n'
                      '            "command": "python \\"$(git rev-parse --show-toplevel 2>/dev/null || '
                      'pwd)/.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py\\" --platform '
                      'codex",\n'
                      '            "commandWindows": "powershell.exe -NoProfile -NonInteractive -Command '
                      '\\"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
                      '$OutputEncoding = [Console]::OutputEncoding; $wikiRoot = git rev-parse '
                      '--show-toplevel 2>$null; if (-not $wikiRoot) { $wikiRoot = (Get-Location).Path }; '
                      'python (Join-Path $wikiRoot '
                      "'.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py') --platform "
                      'codex\\"",\n'
                      '            "timeout": 10,\n'
                      '            "statusMessage": "Loading wiki state"\n'
                      '          }\n'
                      '        ]\n'
                      '      }\n'
                      '    ],\n'
                      '    "PreToolUse": [\n'
                      '      {\n'
                      '        "matcher": '
                      '"^(apply_patch|Edit|Write|create|create_file|edit|editFiles|str_replace|str_replace_editor|multi_replace_string_in_file|replace_string_in_file|write)$",\n'
                      '        "hooks": [\n'
                      '          {\n'
                      '            "type": "command",\n'
                      '            "command": "python \\"$(git rev-parse --show-toplevel 2>/dev/null || '
                      'pwd)/.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py\\" --platform '
                      'codex",\n'
                      '            "commandWindows": "powershell.exe -NoProfile -NonInteractive -Command '
                      '\\"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
                      '$OutputEncoding = [Console]::OutputEncoding; $wikiRoot = git rev-parse '
                      '--show-toplevel 2>$null; if (-not $wikiRoot) { $wikiRoot = (Get-Location).Path }; '
                      'python (Join-Path $wikiRoot '
                      "'.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py') --platform "
                      'codex\\"",\n'
                      '            "timeout": 10,\n'
                      '            "statusMessage": "Checking wiki write boundary"\n'
                      '          }\n'
                      '        ]\n'
                      '      }\n'
                      '    ],\n'
                      '    "PostToolUse": [\n'
                      '      {\n'
                      '        "matcher": '
                      '"^(apply_patch|Edit|Write|create|create_file|edit|editFiles|str_replace|str_replace_editor|multi_replace_string_in_file|replace_string_in_file|write)$",\n'
                      '        "hooks": [\n'
                      '          {\n'
                      '            "type": "command",\n'
                      '            "command": "python \\"$(git rev-parse --show-toplevel 2>/dev/null || '
                      'pwd)/.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py\\" --platform '
                      'codex",\n'
                      '            "commandWindows": "powershell.exe -NoProfile -NonInteractive -Command '
                      '\\"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
                      '$OutputEncoding = [Console]::OutputEncoding; $wikiRoot = git rev-parse '
                      '--show-toplevel 2>$null; if (-not $wikiRoot) { $wikiRoot = (Get-Location).Path }; '
                      'python (Join-Path $wikiRoot '
                      "'.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py') --platform "
                      'codex\\"",\n'
                      '            "timeout": 10,\n'
                      '            "statusMessage": "Checking wiki log reminder"\n'
                      '          }\n'
                      '        ]\n'
                      '      }\n'
                      '    ]\n'
                      '  }\n'
                      '}\n'}


PROFILE_MANIFESTS = {'group': {'agentBlockSha256': '9b11ce6f74edeaa6ce5f70e0f5414b5583cb55459c23e2ae0684de0bbcc4b3cd',
           'capabilities': ['adr',
                            'archaeology',
                            'audit',
                            'business-analysis',
                            'functional-exploration',
                            'ingest',
                            'lint',
                            'megin-resume',
                            'megin-spec-export',
                            'megin-workflow',
                            'merge-repo',
                            'notebooklm-export',
                            'query',
                            'release-review',
                            'synthesis',
                            'system-analysis',
                            'system-design'],
           'files': {'.agents/gitlab-workspace-kit/group-instructions.md': '9eb969cc4c604fed1fdea51ed0140d65a71bb68ecd692312085a7f571381940e',
                     '.agents/gitlab-workspace-kit/legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                     '.agents/gitlab-workspace-kit/profile.md': '59106cc2eaf0e0ad2bfa444e77811768820b22a1a3b1e3c49d17aacb30232595',
                     '.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                     '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a',
                     '.agents/skills/codebase-wiki/SKILL.md': 'eef44d27107ce64931bc29eed20254f1d045a7c541177d6b01d565718c5405ab',
                     '.agents/skills/codebase-wiki/VERSION': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033',
                     '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                     '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                     '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                     '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                     '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                     '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                     '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                     '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                     '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                     '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                     '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                     '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                     '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                     '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                     '.agents/skills/codebase-wiki/assets/development-spec-template.md': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                     '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                     '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                     '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                     '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                     '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                     '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                     '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                     '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                     '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                     '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                     '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                     '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                     '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                     '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                     '.agents/skills/codebase-wiki/assets/target-agents-block.md': '114651f7bbea36880b9530cdee8a73e8484928a400b840db0a10175f7d13b206',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                     '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                     '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                     '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                     '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                     '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                     '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                     '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                     '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                     '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                     '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                     '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                     '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                     '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                     '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                     '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                     '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                     '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                     '.agents/skills/codebase-wiki/references/intent-routing.md': 'b45474b368f600af5ce2638b60785fd45369f48c24815903548904a669b10821',
                     '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                     '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                     '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                     '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                     '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                     '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                     '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                     '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                     '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                     '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                     '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                     '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                     '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                     '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                     '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                     '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                     '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                     '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                     '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                     '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                     '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                     '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                     '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                     '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                     '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                     '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                     '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                     '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                     '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                     '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                     '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                     '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                     '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                     '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                     '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                     '.agents/skills/megin-architecture-exploration/SKILL.md': '1e5ed21281dc13b6a3b8b0b6b99442738729d8976d9b6ddf6c34df330c6ce02a',
                     '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                     '.agents/skills/megin-behavior-contract/SKILL.md': '83778f2134bc540be1a0505f11bec6f5d527663afb85c001b213d27fa70de5c9',
                     '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                     '.agents/skills/megin-bug-diagnosis/SKILL.md': 'bfa82b975e331e1e28dbaefef62ac3f9c0a416c752d7c902bf2daae3a78a7c6f',
                     '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                     '.agents/skills/megin-code-review/SKILL.md': 'ad42321cbb05ec5d720e61dd3166c25b230fdec2733b2b54540f82b019e68cdc',
                     '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                     '.agents/skills/megin-finishing-delivery/SKILL.md': 'bedc013bf24fcd8db951aff275cf9179f2cd62f6fdaf92d204c4773c514c2734',
                     '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                     '.agents/skills/megin-human-acceptance/SKILL.md': 'ff52d3d5e848fc259efc90d8378a9c90fca86c01982d04ff3020a1a9ce14e297',
                     '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                     '.agents/skills/megin-implementation-execution/SKILL.md': '6a7d414abca3b25ec86c1a170916efcc511e629294c3c127388bde89db39b73b',
                     '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                     '.agents/skills/megin-project-knowledge/SKILL.md': '4d820660551d9155c1e8db5fb09b5adbca84ad90ed3f1198bdb44e14747370f5',
                     '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                     '.agents/skills/megin-requirements-discovery/SKILL.md': 'fd265025b37de6b417c55c9f9e4ae656ac3a9d58abe48db4d71e121c5ef734d5',
                     '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                     '.agents/skills/megin-technical-planning/SKILL.md': '1d19ba0ceff9379f4a8fbc0b34eeaa48dbf5b94f8d95f08ea7765ac23d7d7da3',
                     '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                     '.agents/skills/megin-test-driven-development/SKILL.md': 'd4950321814c248dff9712137476d2022614cf82b5289810b89248f183167771',
                     '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                     '.agents/skills/megin-verification-before-completion/SKILL.md': 'cfdb8ee72f5f3f4f0b1bf23cadba19edcc082b2e847a98fd33f719ff9171c5cf',
                     '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                     '.agents/skills/megin/SKILL.md': '24735a8231dc71802d8aca36dba09d49cfcfe5e19c70c96bf6357a44e888d922',
                     '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                     '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                     '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                     '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                     '.agents/skills/megin/references/language-policy.md': 'aafd6a92c6673704f7844674ec6d78f269c2f36804994f60522e8d99c8db1a9a',
                     '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                     '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                     '.agents/skills/megin/references/repository-workflow.md': '33752ca83cdb8f002989e5f1a229047da0b4714a1d622bc13714872457ad2aa6',
                     '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                     '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                     '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                     '.agents/skills/megin/references/workflow-examples.md': '05bc5eeffda1b8cdbf8966f538066f98227b0eddb9ef7cbf0a59d9f78c38028f',
                     '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                     '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                     '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                     '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                     '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                     '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                     '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                     '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                     '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                     '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                     '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                     '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                     '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                     '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                     '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                     '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                     '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                     '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                     '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                     '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                     '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                     '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                     '.agents/skills/merge-reviewer/SKILL.md': '58990026608e6c41efabad6f0c35fb00aa0acf0ae32f56ee6265f0b94b9a4019',
                     '.agents/skills/merge-reviewer/VERSION': 'd84c9e596c7d6a94e5f74579ef8d8912a807b0d28582474900ad35dfb3edfcf4',
                     '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                     '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                     '.agents/skills/merge-reviewer/references/report-style.md': '8db294033b7bc9e95f63fb261afd3404b1e14e79daeece200b02621d3e9e8cab',
                     '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                     '.agents/skills/merge-reviewer/references/usage.md': 'c334cbbc53cf704c254dce68d7aeaee9c86ddfa1f9014c92ee2364bf8496fe1a',
                     '.agents/skills/merge-reviewer/references/workspace-review.md': '40ae633d5dff48f4c719a5b704bf039651e6fd6391aa896362199b01554e1239',
                     '.agents/skills/merge-reviewer/scripts/git_review_context.py': '59b4c8683756d2feeed93828b5fd70e9b21eb68d5030b9b05bc34741ebbe15fc',
                     '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                     '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                     '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'dd1893dae4e2130b35d4aafe0b9cf242e91f7207fefe5dc09ce0d126d4c63c3d',
                     '.agents/skills/merge-reviewer/scripts/workspace_report.py': '289dd799516958763051106ed664e5b77525642c035fdbbd3739973dd25d627d',
                     '.agents/skills/release-reviewer/SKILL.md': '0ce6274557215285a36e79dab1d8dd39053322424eab55c5d6ab41e327dc65dc',
                     '.agents/skills/release-reviewer/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                     '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                     '.agents/skills/release-reviewer/references/evidence-workflow.md': '53f5192f7cf48a6666c65322d8064ea41be4dd2d684d0c6de5fb8787dfd3192e',
                     '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                     '.agents/skills/release-reviewer/references/report-style.md': '65a59312abbb7c299c6b35407ee68dd6d5c56a89165f9ee9734a8bb95849725c',
                     '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                     '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                     '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                     '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                     '.agents/skills/release-reviewer/scripts/evidence.py': '442ecab309ed3413c775adcddbb1dfb05bb98702fff083bed4d74ae0cb6fbc05',
                     '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                     '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                     '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                     '.agents/skills/release-reviewer/scripts/release_report.py': '870abe605bcc8a2ad3177e4154cb022b0ddbdb3064685f9647e54eeddb9e1d59',
                     '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                     '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                     '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
           'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                          'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'eef44d27107ce64931bc29eed20254f1d045a7c541177d6b01d565718c5405ab',
                                                                                                 'upstream_sha256': '80beb93b098162de66e896d00cf2bfb1b4e5688f51a75402cab19f75bd77331b'},
                                                       '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                                                                                                                            'upstream_sha256': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97'},
                                                       '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                                                                                                                                'upstream_sha256': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2'},
                                                       '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                                                                                                                             'upstream_sha256': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4'}}}},
           'payloadSha256': '90b3c5bb98b00f29b2620c89a56b2c96c365ff8c3a346981796aac2a93280435',
           'profileHashes': {'group-instructions.md': '9eb969cc4c604fed1fdea51ed0140d65a71bb68ecd692312085a7f571381940e',
                             'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                             'profile.md': '59106cc2eaf0e0ad2bfa444e77811768820b22a1a3b1e3c49d17aacb30232595'},
           'skills': ['codebase-wiki',
                      'megin',
                      'megin-architecture-exploration',
                      'megin-behavior-contract',
                      'megin-bug-diagnosis',
                      'megin-code-review',
                      'megin-finishing-delivery',
                      'megin-human-acceptance',
                      'megin-implementation-execution',
                      'megin-project-knowledge',
                      'megin-requirements-discovery',
                      'megin-technical-planning',
                      'megin-test-driven-development',
                      'megin-verification-before-completion',
                      'merge-reviewer',
                      'release-reviewer']},
 'repository': {'agentBlockSha256': '4f647de11777b57eaf48ceb9ec0e84380f11d2a8772b6ca80d298089b2fe1feb',
                'capabilities': ['adr',
                                 'archaeology',
                                 'audit',
                                 'business-analysis',
                                 'functional-exploration',
                                 'ingest',
                                 'lint',
                                 'megin-resume',
                                 'megin-spec-export',
                                 'megin-workflow',
                                 'merge-repo',
                                 'notebooklm-export',
                                 'query',
                                 'release-review',
                                 'synthesis',
                                 'system-analysis',
                                 'system-design'],
                'files': {'.agents/gitlab-workspace-kit/group-instructions.md': 'e6364cff46e5acdc52dba09187678bc37255a078ac4dac18d0a71ce35a51d80d',
                          '.agents/gitlab-workspace-kit/legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                          '.agents/gitlab-workspace-kit/profile.md': 'cd4b5e6da74418172299af1f4a60c48cfc5f2dd59f9ee1228f70e50ff28d6311',
                          '.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                          '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a',
                          '.agents/skills/codebase-wiki/SKILL.md': '80beb93b098162de66e896d00cf2bfb1b4e5688f51a75402cab19f75bd77331b',
                          '.agents/skills/codebase-wiki/VERSION': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033',
                          '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                          '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                          '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                          '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                          '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                          '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                          '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                          '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                          '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                          '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                          '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                          '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                          '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                          '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                          '.agents/skills/codebase-wiki/assets/development-spec-template.md': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97',
                          '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                          '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                          '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                          '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                          '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                          '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                          '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                          '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                          '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                          '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                          '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                          '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                          '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                          '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                          '.agents/skills/codebase-wiki/assets/target-agents-block.md': '114651f7bbea36880b9530cdee8a73e8484928a400b840db0a10175f7d13b206',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                          '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                          '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                          '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                          '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                          '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                          '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                          '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                          '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                          '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2',
                          '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                          '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                          '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                          '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                          '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                          '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                          '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                          '.agents/skills/codebase-wiki/references/intent-routing.md': 'b45474b368f600af5ce2638b60785fd45369f48c24815903548904a669b10821',
                          '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                          '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                          '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                          '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                          '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                          '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                          '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                          '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                          '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                          '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                          '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                          '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                          '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                          '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                          '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                          '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                          '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                          '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                          '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                          '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                          '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                          '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                          '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                          '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                          '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                          '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                          '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                          '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                          '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                          '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                          '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                          '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4',
                          '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                          '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                          '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                          '.agents/skills/megin-architecture-exploration/SKILL.md': '1e5ed21281dc13b6a3b8b0b6b99442738729d8976d9b6ddf6c34df330c6ce02a',
                          '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                          '.agents/skills/megin-behavior-contract/SKILL.md': '83778f2134bc540be1a0505f11bec6f5d527663afb85c001b213d27fa70de5c9',
                          '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                          '.agents/skills/megin-bug-diagnosis/SKILL.md': 'bfa82b975e331e1e28dbaefef62ac3f9c0a416c752d7c902bf2daae3a78a7c6f',
                          '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                          '.agents/skills/megin-code-review/SKILL.md': 'ad42321cbb05ec5d720e61dd3166c25b230fdec2733b2b54540f82b019e68cdc',
                          '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                          '.agents/skills/megin-finishing-delivery/SKILL.md': 'bedc013bf24fcd8db951aff275cf9179f2cd62f6fdaf92d204c4773c514c2734',
                          '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                          '.agents/skills/megin-human-acceptance/SKILL.md': 'ff52d3d5e848fc259efc90d8378a9c90fca86c01982d04ff3020a1a9ce14e297',
                          '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                          '.agents/skills/megin-implementation-execution/SKILL.md': '6a7d414abca3b25ec86c1a170916efcc511e629294c3c127388bde89db39b73b',
                          '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                          '.agents/skills/megin-project-knowledge/SKILL.md': '4d820660551d9155c1e8db5fb09b5adbca84ad90ed3f1198bdb44e14747370f5',
                          '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                          '.agents/skills/megin-requirements-discovery/SKILL.md': 'fd265025b37de6b417c55c9f9e4ae656ac3a9d58abe48db4d71e121c5ef734d5',
                          '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                          '.agents/skills/megin-technical-planning/SKILL.md': '1d19ba0ceff9379f4a8fbc0b34eeaa48dbf5b94f8d95f08ea7765ac23d7d7da3',
                          '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                          '.agents/skills/megin-test-driven-development/SKILL.md': 'd4950321814c248dff9712137476d2022614cf82b5289810b89248f183167771',
                          '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                          '.agents/skills/megin-verification-before-completion/SKILL.md': 'cfdb8ee72f5f3f4f0b1bf23cadba19edcc082b2e847a98fd33f719ff9171c5cf',
                          '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                          '.agents/skills/megin/SKILL.md': '24735a8231dc71802d8aca36dba09d49cfcfe5e19c70c96bf6357a44e888d922',
                          '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                          '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                          '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                          '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                          '.agents/skills/megin/references/language-policy.md': 'aafd6a92c6673704f7844674ec6d78f269c2f36804994f60522e8d99c8db1a9a',
                          '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                          '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                          '.agents/skills/megin/references/repository-workflow.md': '33752ca83cdb8f002989e5f1a229047da0b4714a1d622bc13714872457ad2aa6',
                          '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                          '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                          '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                          '.agents/skills/megin/references/workflow-examples.md': '05bc5eeffda1b8cdbf8966f538066f98227b0eddb9ef7cbf0a59d9f78c38028f',
                          '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                          '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                          '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                          '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                          '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                          '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                          '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                          '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                          '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                          '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                          '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                          '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                          '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                          '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                          '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                          '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                          '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                          '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                          '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                          '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                          '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                          '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                          '.agents/skills/merge-reviewer/SKILL.md': '58990026608e6c41efabad6f0c35fb00aa0acf0ae32f56ee6265f0b94b9a4019',
                          '.agents/skills/merge-reviewer/VERSION': 'd84c9e596c7d6a94e5f74579ef8d8912a807b0d28582474900ad35dfb3edfcf4',
                          '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                          '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                          '.agents/skills/merge-reviewer/references/report-style.md': '8db294033b7bc9e95f63fb261afd3404b1e14e79daeece200b02621d3e9e8cab',
                          '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                          '.agents/skills/merge-reviewer/references/usage.md': 'c334cbbc53cf704c254dce68d7aeaee9c86ddfa1f9014c92ee2364bf8496fe1a',
                          '.agents/skills/merge-reviewer/references/workspace-review.md': '40ae633d5dff48f4c719a5b704bf039651e6fd6391aa896362199b01554e1239',
                          '.agents/skills/merge-reviewer/scripts/git_review_context.py': '59b4c8683756d2feeed93828b5fd70e9b21eb68d5030b9b05bc34741ebbe15fc',
                          '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                          '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                          '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'dd1893dae4e2130b35d4aafe0b9cf242e91f7207fefe5dc09ce0d126d4c63c3d',
                          '.agents/skills/merge-reviewer/scripts/workspace_report.py': '289dd799516958763051106ed664e5b77525642c035fdbbd3739973dd25d627d',
                          '.agents/skills/release-reviewer/SKILL.md': '0ce6274557215285a36e79dab1d8dd39053322424eab55c5d6ab41e327dc65dc',
                          '.agents/skills/release-reviewer/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                          '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                          '.agents/skills/release-reviewer/references/evidence-workflow.md': '53f5192f7cf48a6666c65322d8064ea41be4dd2d684d0c6de5fb8787dfd3192e',
                          '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                          '.agents/skills/release-reviewer/references/report-style.md': '65a59312abbb7c299c6b35407ee68dd6d5c56a89165f9ee9734a8bb95849725c',
                          '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                          '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                          '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                          '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                          '.agents/skills/release-reviewer/scripts/evidence.py': '442ecab309ed3413c775adcddbb1dfb05bb98702fff083bed4d74ae0cb6fbc05',
                          '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                          '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                          '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                          '.agents/skills/release-reviewer/scripts/release_report.py': '870abe605bcc8a2ad3177e4154cb022b0ddbdb3064685f9647e54eeddb9e1d59',
                          '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                          '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                          '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
                'overlays': {},
                'payloadSha256': 'd8ad29c37f474db8fa3af82b530c45b4f4814599b4638b9454b2824718084d35',
                'profileHashes': {'group-instructions.md': 'e6364cff46e5acdc52dba09187678bc37255a078ac4dac18d0a71ce35a51d80d',
                                  'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                  'profile.md': 'cd4b5e6da74418172299af1f4a60c48cfc5f2dd59f9ee1228f70e50ff28d6311'},
                'skills': ['codebase-wiki',
                           'megin',
                           'megin-architecture-exploration',
                           'megin-behavior-contract',
                           'megin-bug-diagnosis',
                           'megin-code-review',
                           'megin-finishing-delivery',
                           'megin-human-acceptance',
                           'megin-implementation-execution',
                           'megin-project-knowledge',
                           'megin-requirements-discovery',
                           'megin-technical-planning',
                           'megin-test-driven-development',
                           'megin-verification-before-completion',
                           'merge-reviewer',
                           'release-reviewer']}}
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
UPSTREAM = {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                   'repository': 'code-base-llm-wiki',
                   'root': 'codebase-llm-wiki-codex-0.6.1',
                   'sha256': 'd9b10390028d70a26b473737de582c4b2cf2286d019c03f3d0673f81602bf8ce',
                   'version': '0.6.1'},
 'megin': {'asset': 'megin-skills.zip',
           'repository': 'Megin',
           'root': '',
           'sha256': '2cd73766cd19de5ad26d6437ee50d5c9f3a37f6e67b7193c440e5c3b8d303395',
           'version': '0.8.1'},
 'merge-reviewer': {'asset': 'merge-reviewer-0.13.0.zip',
                    'repository': 'MergeReviewer',
                    'root': '',
                    'sha256': 'd79281b8279ad440b7b7c758323f600ca6ca6b8df6ef3d2bded13191ed0de96a',
                    'version': '0.13.0'},
 'release-reviewer': {'asset': 'release-reviewer-0.4.0.zip',
                      'repository': 'ReleaseReviewer',
                      'root': '',
                      'sha256': '03e07e2d02b7327bcb98a48428fc2c28185d99c74eb90d9c061c5f7ce9c1afd9',
                      'version': '0.4.0'}}
PROFILE_HASHES = {'group-instructions.md': '9eb969cc4c604fed1fdea51ed0140d65a71bb68ecd692312085a7f571381940e',
 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
 'profile.md': '59106cc2eaf0e0ad2bfa444e77811768820b22a1a3b1e3c49d17aacb30232595'}
SOURCE_SUMMARY = ['Native Codebase LLM Wiki 0.6.1 is single-codebase; GitlabWorkSpace overlay restores Group-relative '
 'specifications and shared-Wiki rules.',
 'Native Megin 0.8.1 supplies thirteen Skills, Group v6 cross-Repo impact evidence and Repo v3 workflow; no '
 'Workspace Megin overlay, GitLab delivery or simulation routing is applied.',
 'Native MergeReviewer 0.13.0 accepts one Repo and explicit base/head branches, uses Codex-native review and '
 'v3 fixed evidence, and publishes one Markdown Merge Report with 8-character commit IDs in the filename and '
 'a captured comparison summary. Findings use six fields and cite minimal fixed line ranges with complete '
 'refs; the technical appendix is omitted while full validation is retained. No Workspace overlay or '
 'MR-specific report adapter is applied.',
 'Native ReleaseReviewer 0.4.0 accepts only an explicit Repo and base/head branches, traces affected Group '
 'functionality using pinned local default branches, and writes one concise v3 blocker/resource report with '
 'an editable manual checklist at the VSCode workspace root without an overlay.']
AGENT_BLOCK_SHA256 = '9b11ce6f74edeaa6ce5f70e0f5414b5583cb55459c23e2ae0684de0bbcc4b3cd'
OVERLAY_HASHES = {'codebase-wiki': 'd402efe9545e0f97069afd5ad92e8d4992704ec5199f1454747f9b023f3b16d4'}
CURRENT_PAYLOAD_SHA256 = '90b3c5bb98b00f29b2620c89a56b2c96c365ff8c3a346981796aac2a93280435'
CURRENT_SKILL_FILES = {'.agents/skills/megin-architecture-exploration/SKILL.md': '1e5ed21281dc13b6a3b8b0b6b99442738729d8976d9b6ddf6c34df330c6ce02a',
 '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
 '.agents/skills/megin-behavior-contract/SKILL.md': '83778f2134bc540be1a0505f11bec6f5d527663afb85c001b213d27fa70de5c9',
 '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
 '.agents/skills/megin-bug-diagnosis/SKILL.md': 'bfa82b975e331e1e28dbaefef62ac3f9c0a416c752d7c902bf2daae3a78a7c6f',
 '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
 '.agents/skills/megin-code-review/SKILL.md': 'ad42321cbb05ec5d720e61dd3166c25b230fdec2733b2b54540f82b019e68cdc',
 '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
 '.agents/skills/megin-finishing-delivery/SKILL.md': 'bedc013bf24fcd8db951aff275cf9179f2cd62f6fdaf92d204c4773c514c2734',
 '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
 '.agents/skills/megin-human-acceptance/SKILL.md': 'ff52d3d5e848fc259efc90d8378a9c90fca86c01982d04ff3020a1a9ce14e297',
 '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
 '.agents/skills/megin-implementation-execution/SKILL.md': '6a7d414abca3b25ec86c1a170916efcc511e629294c3c127388bde89db39b73b',
 '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
 '.agents/skills/megin-project-knowledge/SKILL.md': '4d820660551d9155c1e8db5fb09b5adbca84ad90ed3f1198bdb44e14747370f5',
 '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
 '.agents/skills/megin-requirements-discovery/SKILL.md': 'fd265025b37de6b417c55c9f9e4ae656ac3a9d58abe48db4d71e121c5ef734d5',
 '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
 '.agents/skills/megin-technical-planning/SKILL.md': '1d19ba0ceff9379f4a8fbc0b34eeaa48dbf5b94f8d95f08ea7765ac23d7d7da3',
 '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
 '.agents/skills/megin-test-driven-development/SKILL.md': 'd4950321814c248dff9712137476d2022614cf82b5289810b89248f183167771',
 '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
 '.agents/skills/megin-verification-before-completion/SKILL.md': 'cfdb8ee72f5f3f4f0b1bf23cadba19edcc082b2e847a98fd33f719ff9171c5cf',
 '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
 '.agents/skills/megin/SKILL.md': '24735a8231dc71802d8aca36dba09d49cfcfe5e19c70c96bf6357a44e888d922',
 '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
 '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
 '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
 '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
 '.agents/skills/megin/references/language-policy.md': 'aafd6a92c6673704f7844674ec6d78f269c2f36804994f60522e8d99c8db1a9a',
 '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
 '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
 '.agents/skills/megin/references/repository-workflow.md': '33752ca83cdb8f002989e5f1a229047da0b4714a1d622bc13714872457ad2aa6',
 '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
 '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
 '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
 '.agents/skills/megin/references/workflow-examples.md': '05bc5eeffda1b8cdbf8966f538066f98227b0eddb9ef7cbf0a59d9f78c38028f',
 '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
 '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
 '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
 '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
 '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
 '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
 '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
 '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
 '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
 '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
 '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
 '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
 '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
 '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
 '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
 '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
 '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
 '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
 '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
 '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
 '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
 '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
 '.agents/skills/merge-reviewer/SKILL.md': '58990026608e6c41efabad6f0c35fb00aa0acf0ae32f56ee6265f0b94b9a4019',
 '.agents/skills/merge-reviewer/VERSION': 'd84c9e596c7d6a94e5f74579ef8d8912a807b0d28582474900ad35dfb3edfcf4',
 '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
 '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
 '.agents/skills/merge-reviewer/references/report-style.md': '8db294033b7bc9e95f63fb261afd3404b1e14e79daeece200b02621d3e9e8cab',
 '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
 '.agents/skills/merge-reviewer/references/usage.md': 'c334cbbc53cf704c254dce68d7aeaee9c86ddfa1f9014c92ee2364bf8496fe1a',
 '.agents/skills/merge-reviewer/references/workspace-review.md': '40ae633d5dff48f4c719a5b704bf039651e6fd6391aa896362199b01554e1239',
 '.agents/skills/merge-reviewer/scripts/git_review_context.py': '59b4c8683756d2feeed93828b5fd70e9b21eb68d5030b9b05bc34741ebbe15fc',
 '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
 '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
 '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'dd1893dae4e2130b35d4aafe0b9cf242e91f7207fefe5dc09ce0d126d4c63c3d',
 '.agents/skills/merge-reviewer/scripts/workspace_report.py': '289dd799516958763051106ed664e5b77525642c035fdbbd3739973dd25d627d',
 '.agents/skills/release-reviewer/SKILL.md': '0ce6274557215285a36e79dab1d8dd39053322424eab55c5d6ab41e327dc65dc',
 '.agents/skills/release-reviewer/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
 '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
 '.agents/skills/release-reviewer/references/evidence-workflow.md': '53f5192f7cf48a6666c65322d8064ea41be4dd2d684d0c6de5fb8787dfd3192e',
 '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
 '.agents/skills/release-reviewer/references/report-style.md': '65a59312abbb7c299c6b35407ee68dd6d5c56a89165f9ee9734a8bb95849725c',
 '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
 '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
 '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
 '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
 '.agents/skills/release-reviewer/scripts/evidence.py': '442ecab309ed3413c775adcddbb1dfb05bb98702fff083bed4d74ae0cb6fbc05',
 '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
 '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
 '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
 '.agents/skills/release-reviewer/scripts/release_report.py': '870abe605bcc8a2ad3177e4154cb022b0ddbdb3064685f9647e54eeddb9e1d59',
 '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
 '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
 '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'}
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
 'packages': [{'agentBlockSha256': '8405673e15088a7fb2284a9e406de623df03c6de2a803886fa29f0a50290d321',
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
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
               'profileHashes': {'group-instructions.md': '3641177df6c3755a8199457f3325fdc31f1d9927d285f662753dae86b1f6aa68',
                                 'legacy-cleanup.md': '94cf39440fa211f72036c524ecdc56a36df971ef2cdc6e4deefb9768fa9ad29a',
                                 'profile.md': '4ecc186f14ef5a2cb206eb0e99371995a7c11539ca76ddf3d94da197f2c3ade3'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer'],
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
               'version': '0.13.2',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                             '.agents/skills/codebase-wiki/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '70dc9a02b4bedf81945b486bdbc4afd47b8ae72c62aa76022cbfcb883e9947eb',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '355dce15a4749863d59d14042f4f6352b9e333f4c5ab40e66762c190a4a4902a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '4050ec34edb6f6e327aed9a523257d8ea561b5f93be81e751a1d5a234e2f5514',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '8405673e15088a7fb2284a9e406de623df03c6de2a803886fa29f0a50290d321',
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
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
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                                                                                                     'upstream_sha256': '654b4bd8444eaa36b96e49eb498b6c37ce0b6b65ba1d4a48cb2a9c11992e5e85'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                                                                                                                                'upstream_sha256': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                                                                                                                                    'upstream_sha256': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                                                                                                                                 'upstream_sha256': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994'}}},
                            'megin': {'added': {'.agents/skills/megin/references/cross-flow-delivery.md': '69861d9f5093d28c3f4a382ab20eca39a21673b71bb40fb72165cb5c893d6f04',
                                                '.agents/skills/megin/references/cross-repo-evidence.md': 'f2a21fc6c4a82515a8fec92bf65f77e60106a80a06a7d05e9b8b95097b276372',
                                                '.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                                                '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                                                '.agents/skills/megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                                                '.agents/skills/megin/scripts/delivery_receipt.py': '661cecae50a14a41d90c9163b0e453864653acb0272ee8ef3b9f2a0088046a4c',
                                                '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                                                '.agents/skills/megin/scripts/group_quality_gate.py': '39c26dd61db692ca21b1a2202c15380ed729d21f7cb694e98dd82ee97b3b7e21',
                                                '.agents/skills/megin/scripts/group_workspace.py': 'b2147acc1f08215eb27fa6db1e3bfd95d111ca30c5c3a3fae0e83026428a5e58',
                                                '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                                                '.agents/skills/megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                                                '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b'},
                                      'replaced': {'.agents/skills/megin-behavior-contract/SKILL.md': {'overlay_sha256': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                                                                                                       'upstream_sha256': '02aa0daad3fb3b8442c3bf6c8be10b394f25c493a9ab6a372842a1a59ec9c721'},
                                                   '.agents/skills/megin-bug-diagnosis/SKILL.md': {'overlay_sha256': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                                                                                                   'upstream_sha256': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac'},
                                                   '.agents/skills/megin-code-review/SKILL.md': {'overlay_sha256': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                                                                                                 'upstream_sha256': '900b19674c59db08c39c6e8689616009354df060c45daab717fd7c4f196444f1'},
                                                   '.agents/skills/megin-finishing-delivery/SKILL.md': {'overlay_sha256': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                                                                                                        'upstream_sha256': 'ba37595ff65c8f696a17262532314337669cd3c5d9a1bd80d7ca90948d145629'},
                                                   '.agents/skills/megin-human-acceptance/SKILL.md': {'overlay_sha256': '4ce75e7f4d0eb9d89cbd2a6d0307e45def505afa15e564a49c4bfb4e3b77167f',
                                                                                                      'upstream_sha256': 'f91be08047b952131f20b0b08b1dfd370876ffe610601c4bb35ef652aa38eebe'},
                                                   '.agents/skills/megin-implementation-execution/SKILL.md': {'overlay_sha256': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                                                                                                              'upstream_sha256': 'bd5d20009f6f9575364ea81dbd46da032beb19effce79137cc3acdb07c861f8a'},
                                                   '.agents/skills/megin-project-knowledge/SKILL.md': {'overlay_sha256': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                                                                                                       'upstream_sha256': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1'},
                                                   '.agents/skills/megin-requirements-discovery/SKILL.md': {'overlay_sha256': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                                                                                                            'upstream_sha256': '76eb90a15cdedc70fa6283b7082444c65e08241caa8b29c58efa9cca6d43f589'},
                                                   '.agents/skills/megin-technical-planning/SKILL.md': {'overlay_sha256': '35bc74ab0bd40d29569e603e36a564cb9ad381ccd189a9629ee297f69f45cf5c',
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
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                                                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'bd435317c2d83926b42a3e9322c6749dc32c5477fb934639eb1fa7074bfb8849',
                                                         '.agents/skills/merge-reviewer/references/native-review.md': '34958c9843041b806e512f95ca455b29130c8953a860dd379e1d2b7051994597',
                                                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': 'ec17398cf4df3d44352cf39cc74afc277158d5ba342f3a00082f8414f7ab485e',
                                                         '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': 'fe61b1a80ef4e7a201fe3b6df28092dbd6daaa77370a2958c0054005514750fd',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '090e68cad120c988cfddb48a44ae5372c85d31b8891b2fc911366f18b77c47fd',
                                                                                                       'upstream_sha256': '7734810f9d1674eeffc8f435c2d57c261e9de3c25cf731b61634ef11c8fc374f'},
                                                            '.agents/skills/merge-reviewer/scripts/git_review_context.py': {'overlay_sha256': 'd07a606b0a1ad1664923e8758cd320665ee53cbb213c6357305aa3adbfda9f1b',
                                                                                                                            'upstream_sha256': '9ce0a525b58ad0693ab7e39e6de821d5a87c2876972b7a8472af0236b303ab10'}}}},
               'payloadSha256': '700bbd3cd4fabc3513a2874a934377f4fd0591e7e0276c905398fc4a6a548029',
               'profileHashes': {'group-instructions.md': '3641177df6c3755a8199457f3325fdc31f1d9927d285f662753dae86b1f6aa68',
                                 'legacy-cleanup.md': '94cf39440fa211f72036c524ecdc56a36df971ef2cdc6e4deefb9768fa9ad29a',
                                 'profile.md': '4ecc186f14ef5a2cb206eb0e99371995a7c11539ca76ddf3d94da197f2c3ade3'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer'],
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
               'version': '0.13.2',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                             '.agents/skills/codebase-wiki/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '70dc9a02b4bedf81945b486bdbc4afd47b8ae72c62aa76022cbfcb883e9947eb',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '355dce15a4749863d59d14042f4f6352b9e333f4c5ab40e66762c190a4a4902a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '4050ec34edb6f6e327aed9a523257d8ea561b5f93be81e751a1d5a234e2f5514',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '8405673e15088a7fb2284a9e406de623df03c6de2a803886fa29f0a50290d321',
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
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
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                                                                                                     'upstream_sha256': '654b4bd8444eaa36b96e49eb498b6c37ce0b6b65ba1d4a48cb2a9c11992e5e85'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                                                                                                                                'upstream_sha256': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                                                                                                                                    'upstream_sha256': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                                                                                                                                 'upstream_sha256': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994'}}},
                            'megin': {'added': {'.agents/skills/megin/references/cross-flow-delivery.md': '69861d9f5093d28c3f4a382ab20eca39a21673b71bb40fb72165cb5c893d6f04',
                                                '.agents/skills/megin/references/cross-repo-evidence.md': 'f2a21fc6c4a82515a8fec92bf65f77e60106a80a06a7d05e9b8b95097b276372',
                                                '.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                                                '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                                                '.agents/skills/megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                                                '.agents/skills/megin/scripts/delivery_receipt.py': '661cecae50a14a41d90c9163b0e453864653acb0272ee8ef3b9f2a0088046a4c',
                                                '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                                                '.agents/skills/megin/scripts/group_quality_gate.py': '39c26dd61db692ca21b1a2202c15380ed729d21f7cb694e98dd82ee97b3b7e21',
                                                '.agents/skills/megin/scripts/group_workspace.py': 'b2147acc1f08215eb27fa6db1e3bfd95d111ca30c5c3a3fae0e83026428a5e58',
                                                '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                                                '.agents/skills/megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                                                '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b'},
                                      'replaced': {'.agents/skills/megin-behavior-contract/SKILL.md': {'overlay_sha256': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                                                                                                       'upstream_sha256': '02aa0daad3fb3b8442c3bf6c8be10b394f25c493a9ab6a372842a1a59ec9c721'},
                                                   '.agents/skills/megin-bug-diagnosis/SKILL.md': {'overlay_sha256': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                                                                                                   'upstream_sha256': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac'},
                                                   '.agents/skills/megin-code-review/SKILL.md': {'overlay_sha256': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                                                                                                 'upstream_sha256': '900b19674c59db08c39c6e8689616009354df060c45daab717fd7c4f196444f1'},
                                                   '.agents/skills/megin-finishing-delivery/SKILL.md': {'overlay_sha256': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                                                                                                        'upstream_sha256': 'ba37595ff65c8f696a17262532314337669cd3c5d9a1bd80d7ca90948d145629'},
                                                   '.agents/skills/megin-human-acceptance/SKILL.md': {'overlay_sha256': '4ce75e7f4d0eb9d89cbd2a6d0307e45def505afa15e564a49c4bfb4e3b77167f',
                                                                                                      'upstream_sha256': 'f91be08047b952131f20b0b08b1dfd370876ffe610601c4bb35ef652aa38eebe'},
                                                   '.agents/skills/megin-implementation-execution/SKILL.md': {'overlay_sha256': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                                                                                                              'upstream_sha256': 'bd5d20009f6f9575364ea81dbd46da032beb19effce79137cc3acdb07c861f8a'},
                                                   '.agents/skills/megin-project-knowledge/SKILL.md': {'overlay_sha256': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                                                                                                       'upstream_sha256': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1'},
                                                   '.agents/skills/megin-requirements-discovery/SKILL.md': {'overlay_sha256': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                                                                                                            'upstream_sha256': '76eb90a15cdedc70fa6283b7082444c65e08241caa8b29c58efa9cca6d43f589'},
                                                   '.agents/skills/megin-technical-planning/SKILL.md': {'overlay_sha256': '35bc74ab0bd40d29569e603e36a564cb9ad381ccd189a9629ee297f69f45cf5c',
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
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                                                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'bd435317c2d83926b42a3e9322c6749dc32c5477fb934639eb1fa7074bfb8849',
                                                         '.agents/skills/merge-reviewer/references/native-review.md': '34958c9843041b806e512f95ca455b29130c8953a860dd379e1d2b7051994597',
                                                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': 'ec17398cf4df3d44352cf39cc74afc277158d5ba342f3a00082f8414f7ab485e',
                                                         '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': 'fe61b1a80ef4e7a201fe3b6df28092dbd6daaa77370a2958c0054005514750fd',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '090e68cad120c988cfddb48a44ae5372c85d31b8891b2fc911366f18b77c47fd',
                                                                                                       'upstream_sha256': '7734810f9d1674eeffc8f435c2d57c261e9de3c25cf731b61634ef11c8fc374f'},
                                                            '.agents/skills/merge-reviewer/scripts/git_review_context.py': {'overlay_sha256': 'd07a606b0a1ad1664923e8758cd320665ee53cbb213c6357305aa3adbfda9f1b',
                                                                                                                            'upstream_sha256': '9ce0a525b58ad0693ab7e39e6de821d5a87c2876972b7a8472af0236b303ab10'}}}},
               'payloadSha256': '700bbd3cd4fabc3513a2874a934377f4fd0591e7e0276c905398fc4a6a548029',
               'profileHashes': {'group-instructions.md': '3641177df6c3755a8199457f3325fdc31f1d9927d285f662753dae86b1f6aa68',
                                 'legacy-cleanup.md': '94cf39440fa211f72036c524ecdc56a36df971ef2cdc6e4deefb9768fa9ad29a',
                                 'profile.md': '4ecc186f14ef5a2cb206eb0e99371995a7c11539ca76ddf3d94da197f2c3ade3'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer'],
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
               'version': '0.14.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                             '.agents/skills/codebase-wiki/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '70dc9a02b4bedf81945b486bdbc4afd47b8ae72c62aa76022cbfcb883e9947eb',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '355dce15a4749863d59d14042f4f6352b9e333f4c5ab40e66762c190a4a4902a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '4050ec34edb6f6e327aed9a523257d8ea561b5f93be81e751a1d5a234e2f5514',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '7b1dbbca98399cb38aa38448e3950e99b9ced8aa772debf64cbebc2677c3ccf3',
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
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
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2',
                         '.agents/skills/release-reviewer/SKILL.md': 'c71626fbbf52201eb6066181ac5669f10ecfa0279fdb2d67c1bad6da22eaa98f',
                         '.agents/skills/release-reviewer/VERSION': 'e9dd8507f4bf0c6f42458e41aea833ad0bd3f6127272335eee9bf4d58541ed67',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '4e104534e21a9be419d34c761bb2d0c4af89e1cb4067576a071d6d654a800ada',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'bc4972f0a80d70f5aa532de9d0e8182983672b87eb21c5111033b2e39dc9e4d0',
                         '.agents/skills/release-reviewer/scripts/evidence.py': 'a95377326f41785f4fd8184eab6d5ced9cd968400b945fd1584236b98412f09e',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '28fbdfb4aa545edbf91b7839405c3b624df2be5e56acc86138fcf2695251f870',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'c3f36b06abf283bc8d6384491d25d41f4ef1c74fcb9a9cb63fbf3418fe3790dc',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '48a00d60194632544c63698ac3becef88962ebbd6c4756a187c6a28346c93083',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                                                                                                     'upstream_sha256': '654b4bd8444eaa36b96e49eb498b6c37ce0b6b65ba1d4a48cb2a9c11992e5e85'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                                                                                                                                'upstream_sha256': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                                                                                                                                    'upstream_sha256': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                                                                                                                                 'upstream_sha256': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994'}}},
                            'megin': {'added': {'.agents/skills/megin/references/cross-flow-delivery.md': '69861d9f5093d28c3f4a382ab20eca39a21673b71bb40fb72165cb5c893d6f04',
                                                '.agents/skills/megin/references/cross-repo-evidence.md': 'f2a21fc6c4a82515a8fec92bf65f77e60106a80a06a7d05e9b8b95097b276372',
                                                '.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                                                '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                                                '.agents/skills/megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                                                '.agents/skills/megin/scripts/delivery_receipt.py': '661cecae50a14a41d90c9163b0e453864653acb0272ee8ef3b9f2a0088046a4c',
                                                '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                                                '.agents/skills/megin/scripts/group_quality_gate.py': '39c26dd61db692ca21b1a2202c15380ed729d21f7cb694e98dd82ee97b3b7e21',
                                                '.agents/skills/megin/scripts/group_workspace.py': 'b2147acc1f08215eb27fa6db1e3bfd95d111ca30c5c3a3fae0e83026428a5e58',
                                                '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                                                '.agents/skills/megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                                                '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b'},
                                      'replaced': {'.agents/skills/megin-behavior-contract/SKILL.md': {'overlay_sha256': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                                                                                                       'upstream_sha256': '02aa0daad3fb3b8442c3bf6c8be10b394f25c493a9ab6a372842a1a59ec9c721'},
                                                   '.agents/skills/megin-bug-diagnosis/SKILL.md': {'overlay_sha256': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                                                                                                   'upstream_sha256': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac'},
                                                   '.agents/skills/megin-code-review/SKILL.md': {'overlay_sha256': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                                                                                                 'upstream_sha256': '900b19674c59db08c39c6e8689616009354df060c45daab717fd7c4f196444f1'},
                                                   '.agents/skills/megin-finishing-delivery/SKILL.md': {'overlay_sha256': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                                                                                                        'upstream_sha256': 'ba37595ff65c8f696a17262532314337669cd3c5d9a1bd80d7ca90948d145629'},
                                                   '.agents/skills/megin-human-acceptance/SKILL.md': {'overlay_sha256': '4ce75e7f4d0eb9d89cbd2a6d0307e45def505afa15e564a49c4bfb4e3b77167f',
                                                                                                      'upstream_sha256': 'f91be08047b952131f20b0b08b1dfd370876ffe610601c4bb35ef652aa38eebe'},
                                                   '.agents/skills/megin-implementation-execution/SKILL.md': {'overlay_sha256': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                                                                                                              'upstream_sha256': 'bd5d20009f6f9575364ea81dbd46da032beb19effce79137cc3acdb07c861f8a'},
                                                   '.agents/skills/megin-project-knowledge/SKILL.md': {'overlay_sha256': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                                                                                                       'upstream_sha256': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1'},
                                                   '.agents/skills/megin-requirements-discovery/SKILL.md': {'overlay_sha256': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                                                                                                            'upstream_sha256': '76eb90a15cdedc70fa6283b7082444c65e08241caa8b29c58efa9cca6d43f589'},
                                                   '.agents/skills/megin-technical-planning/SKILL.md': {'overlay_sha256': '35bc74ab0bd40d29569e603e36a564cb9ad381ccd189a9629ee297f69f45cf5c',
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
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                                                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'bd435317c2d83926b42a3e9322c6749dc32c5477fb934639eb1fa7074bfb8849',
                                                         '.agents/skills/merge-reviewer/references/native-review.md': '34958c9843041b806e512f95ca455b29130c8953a860dd379e1d2b7051994597',
                                                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': 'ec17398cf4df3d44352cf39cc74afc277158d5ba342f3a00082f8414f7ab485e',
                                                         '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': 'fe61b1a80ef4e7a201fe3b6df28092dbd6daaa77370a2958c0054005514750fd',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '090e68cad120c988cfddb48a44ae5372c85d31b8891b2fc911366f18b77c47fd',
                                                                                                       'upstream_sha256': '7734810f9d1674eeffc8f435c2d57c261e9de3c25cf731b61634ef11c8fc374f'},
                                                            '.agents/skills/merge-reviewer/scripts/git_review_context.py': {'overlay_sha256': 'd07a606b0a1ad1664923e8758cd320665ee53cbb213c6357305aa3adbfda9f1b',
                                                                                                                            'upstream_sha256': '9ce0a525b58ad0693ab7e39e6de821d5a87c2876972b7a8472af0236b303ab10'}}}},
               'payloadSha256': 'ff1f8452ef10f2b1e947a888fb6f66efe97606dcf899cc710050a1d414e9d63a',
               'profileHashes': {'group-instructions.md': 'bbdfcad4b0d29be4a736c050f85f56a28ccac7cebbded19567d45b15c7d3ce89',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'baae8d598252ddb2daf741d8922eac8c4404c2d6badbfbe5435d5b275a400450'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
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
                                               'version': '0.7.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.1.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '7f7b3486e46f190eb5e4b92f0c35b25f10e40fd6ece0a6f3764d48783431a646',
                                                 'version': '0.1.0'}},
               'version': '0.15.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                             '.agents/skills/codebase-wiki/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '70dc9a02b4bedf81945b486bdbc4afd47b8ae72c62aa76022cbfcb883e9947eb',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '355dce15a4749863d59d14042f4f6352b9e333f4c5ab40e66762c190a4a4902a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '4050ec34edb6f6e327aed9a523257d8ea561b5f93be81e751a1d5a234e2f5514',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '7b1dbbca98399cb38aa38448e3950e99b9ced8aa772debf64cbebc2677c3ccf3',
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
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
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2',
                         '.agents/skills/release-reviewer/SKILL.md': 'c71626fbbf52201eb6066181ac5669f10ecfa0279fdb2d67c1bad6da22eaa98f',
                         '.agents/skills/release-reviewer/VERSION': 'e9dd8507f4bf0c6f42458e41aea833ad0bd3f6127272335eee9bf4d58541ed67',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '4e104534e21a9be419d34c761bb2d0c4af89e1cb4067576a071d6d654a800ada',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'bc4972f0a80d70f5aa532de9d0e8182983672b87eb21c5111033b2e39dc9e4d0',
                         '.agents/skills/release-reviewer/scripts/evidence.py': 'a95377326f41785f4fd8184eab6d5ced9cd968400b945fd1584236b98412f09e',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '28fbdfb4aa545edbf91b7839405c3b624df2be5e56acc86138fcf2695251f870',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'c3f36b06abf283bc8d6384491d25d41f4ef1c74fcb9a9cb63fbf3418fe3790dc',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '48a00d60194632544c63698ac3becef88962ebbd6c4756a187c6a28346c93083',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                                                                                                     'upstream_sha256': '654b4bd8444eaa36b96e49eb498b6c37ce0b6b65ba1d4a48cb2a9c11992e5e85'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                                                                                                                                'upstream_sha256': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                                                                                                                                    'upstream_sha256': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                                                                                                                                 'upstream_sha256': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994'}}},
                            'megin': {'added': {'.agents/skills/megin/references/cross-flow-delivery.md': '69861d9f5093d28c3f4a382ab20eca39a21673b71bb40fb72165cb5c893d6f04',
                                                '.agents/skills/megin/references/cross-repo-evidence.md': 'f2a21fc6c4a82515a8fec92bf65f77e60106a80a06a7d05e9b8b95097b276372',
                                                '.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                                                '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                                                '.agents/skills/megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                                                '.agents/skills/megin/scripts/delivery_receipt.py': '661cecae50a14a41d90c9163b0e453864653acb0272ee8ef3b9f2a0088046a4c',
                                                '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                                                '.agents/skills/megin/scripts/group_quality_gate.py': '39c26dd61db692ca21b1a2202c15380ed729d21f7cb694e98dd82ee97b3b7e21',
                                                '.agents/skills/megin/scripts/group_workspace.py': 'b2147acc1f08215eb27fa6db1e3bfd95d111ca30c5c3a3fae0e83026428a5e58',
                                                '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                                                '.agents/skills/megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                                                '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b'},
                                      'replaced': {'.agents/skills/megin-behavior-contract/SKILL.md': {'overlay_sha256': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                                                                                                       'upstream_sha256': '02aa0daad3fb3b8442c3bf6c8be10b394f25c493a9ab6a372842a1a59ec9c721'},
                                                   '.agents/skills/megin-bug-diagnosis/SKILL.md': {'overlay_sha256': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                                                                                                   'upstream_sha256': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac'},
                                                   '.agents/skills/megin-code-review/SKILL.md': {'overlay_sha256': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                                                                                                 'upstream_sha256': '900b19674c59db08c39c6e8689616009354df060c45daab717fd7c4f196444f1'},
                                                   '.agents/skills/megin-finishing-delivery/SKILL.md': {'overlay_sha256': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                                                                                                        'upstream_sha256': 'ba37595ff65c8f696a17262532314337669cd3c5d9a1bd80d7ca90948d145629'},
                                                   '.agents/skills/megin-human-acceptance/SKILL.md': {'overlay_sha256': '4ce75e7f4d0eb9d89cbd2a6d0307e45def505afa15e564a49c4bfb4e3b77167f',
                                                                                                      'upstream_sha256': 'f91be08047b952131f20b0b08b1dfd370876ffe610601c4bb35ef652aa38eebe'},
                                                   '.agents/skills/megin-implementation-execution/SKILL.md': {'overlay_sha256': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                                                                                                              'upstream_sha256': 'bd5d20009f6f9575364ea81dbd46da032beb19effce79137cc3acdb07c861f8a'},
                                                   '.agents/skills/megin-project-knowledge/SKILL.md': {'overlay_sha256': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                                                                                                       'upstream_sha256': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1'},
                                                   '.agents/skills/megin-requirements-discovery/SKILL.md': {'overlay_sha256': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                                                                                                            'upstream_sha256': '76eb90a15cdedc70fa6283b7082444c65e08241caa8b29c58efa9cca6d43f589'},
                                                   '.agents/skills/megin-technical-planning/SKILL.md': {'overlay_sha256': '35bc74ab0bd40d29569e603e36a564cb9ad381ccd189a9629ee297f69f45cf5c',
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
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                                                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'bd435317c2d83926b42a3e9322c6749dc32c5477fb934639eb1fa7074bfb8849',
                                                         '.agents/skills/merge-reviewer/references/native-review.md': '34958c9843041b806e512f95ca455b29130c8953a860dd379e1d2b7051994597',
                                                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': 'ec17398cf4df3d44352cf39cc74afc277158d5ba342f3a00082f8414f7ab485e',
                                                         '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': 'fe61b1a80ef4e7a201fe3b6df28092dbd6daaa77370a2958c0054005514750fd',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '090e68cad120c988cfddb48a44ae5372c85d31b8891b2fc911366f18b77c47fd',
                                                                                                       'upstream_sha256': '7734810f9d1674eeffc8f435c2d57c261e9de3c25cf731b61634ef11c8fc374f'},
                                                            '.agents/skills/merge-reviewer/scripts/git_review_context.py': {'overlay_sha256': 'd07a606b0a1ad1664923e8758cd320665ee53cbb213c6357305aa3adbfda9f1b',
                                                                                                                            'upstream_sha256': '9ce0a525b58ad0693ab7e39e6de821d5a87c2876972b7a8472af0236b303ab10'}}}},
               'payloadSha256': 'ff1f8452ef10f2b1e947a888fb6f66efe97606dcf899cc710050a1d414e9d63a',
               'profileHashes': {'group-instructions.md': 'bbdfcad4b0d29be4a736c050f85f56a28ccac7cebbded19567d45b15c7d3ce89',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'baae8d598252ddb2daf741d8922eac8c4404c2d6badbfbe5435d5b275a400450'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
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
                                               'version': '0.7.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.1.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '7f7b3486e46f190eb5e4b92f0c35b25f10e40fd6ece0a6f3764d48783431a646',
                                                 'version': '0.1.0'}},
               'version': '0.16.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                             '.agents/skills/codebase-wiki/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '70dc9a02b4bedf81945b486bdbc4afd47b8ae72c62aa76022cbfcb883e9947eb',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '355dce15a4749863d59d14042f4f6352b9e333f4c5ab40e66762c190a4a4902a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '4050ec34edb6f6e327aed9a523257d8ea561b5f93be81e751a1d5a234e2f5514',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '7b1dbbca98399cb38aa38448e3950e99b9ced8aa772debf64cbebc2677c3ccf3',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'development-spec',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-workflow',
                                'merge-group',
                                'merge-mr',
                                'merge-quick',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
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
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2',
                         '.agents/skills/release-reviewer/SKILL.md': 'c71626fbbf52201eb6066181ac5669f10ecfa0279fdb2d67c1bad6da22eaa98f',
                         '.agents/skills/release-reviewer/VERSION': 'e9dd8507f4bf0c6f42458e41aea833ad0bd3f6127272335eee9bf4d58541ed67',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '4e104534e21a9be419d34c761bb2d0c4af89e1cb4067576a071d6d654a800ada',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'bc4972f0a80d70f5aa532de9d0e8182983672b87eb21c5111033b2e39dc9e4d0',
                         '.agents/skills/release-reviewer/scripts/evidence.py': 'a95377326f41785f4fd8184eab6d5ced9cd968400b945fd1584236b98412f09e',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '28fbdfb4aa545edbf91b7839405c3b624df2be5e56acc86138fcf2695251f870',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'c3f36b06abf283bc8d6384491d25d41f4ef1c74fcb9a9cb63fbf3418fe3790dc',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '48a00d60194632544c63698ac3becef88962ebbd6c4756a187c6a28346c93083',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                                                                                                     'upstream_sha256': '654b4bd8444eaa36b96e49eb498b6c37ce0b6b65ba1d4a48cb2a9c11992e5e85'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                                                                                                                                'upstream_sha256': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                                                                                                                                    'upstream_sha256': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                                                                                                                                 'upstream_sha256': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994'}}},
                            'megin': {'added': {'.agents/skills/megin/references/cross-flow-delivery.md': '69861d9f5093d28c3f4a382ab20eca39a21673b71bb40fb72165cb5c893d6f04',
                                                '.agents/skills/megin/references/cross-repo-evidence.md': 'f2a21fc6c4a82515a8fec92bf65f77e60106a80a06a7d05e9b8b95097b276372',
                                                '.agents/skills/megin/references/gitlab-delivery.md': 'ca3d55f62c1c405eb14e4b974ee3caf55e63907f170799cd891f3311a2214ac3',
                                                '.agents/skills/megin/references/group-workspace.md': 'b4978d5b0003a5033ac1da0847957a4b105b44624336954024fccfbccaba2901',
                                                '.agents/skills/megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                                                '.agents/skills/megin/scripts/delivery_receipt.py': '661cecae50a14a41d90c9163b0e453864653acb0272ee8ef3b9f2a0088046a4c',
                                                '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                                                '.agents/skills/megin/scripts/group_quality_gate.py': '39c26dd61db692ca21b1a2202c15380ed729d21f7cb694e98dd82ee97b3b7e21',
                                                '.agents/skills/megin/scripts/group_workspace.py': 'b2147acc1f08215eb27fa6db1e3bfd95d111ca30c5c3a3fae0e83026428a5e58',
                                                '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                                                '.agents/skills/megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                                                '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b'},
                                      'replaced': {'.agents/skills/megin-behavior-contract/SKILL.md': {'overlay_sha256': '429206282e308f293720029206711530bc9c9fe0ccf8c6820e2e3f8922c819f2',
                                                                                                       'upstream_sha256': '02aa0daad3fb3b8442c3bf6c8be10b394f25c493a9ab6a372842a1a59ec9c721'},
                                                   '.agents/skills/megin-bug-diagnosis/SKILL.md': {'overlay_sha256': 'fb0424e41526d719905b09393dfa9fd96bc66183472f46990530578667235f3d',
                                                                                                   'upstream_sha256': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac'},
                                                   '.agents/skills/megin-code-review/SKILL.md': {'overlay_sha256': '82029738a01c88b942fc8848bdf3386b27027fc887e915e6e7f7604efeade4fa',
                                                                                                 'upstream_sha256': '900b19674c59db08c39c6e8689616009354df060c45daab717fd7c4f196444f1'},
                                                   '.agents/skills/megin-finishing-delivery/SKILL.md': {'overlay_sha256': 'dbe23e256972732082c11bcdd570c3ae63585fb52be930626fe34eee91c2b097',
                                                                                                        'upstream_sha256': 'ba37595ff65c8f696a17262532314337669cd3c5d9a1bd80d7ca90948d145629'},
                                                   '.agents/skills/megin-human-acceptance/SKILL.md': {'overlay_sha256': '4ce75e7f4d0eb9d89cbd2a6d0307e45def505afa15e564a49c4bfb4e3b77167f',
                                                                                                      'upstream_sha256': 'f91be08047b952131f20b0b08b1dfd370876ffe610601c4bb35ef652aa38eebe'},
                                                   '.agents/skills/megin-implementation-execution/SKILL.md': {'overlay_sha256': '2cb8c4f54201a9d2022716568bae91bdb459df1fa25cd008467536d5e7e97d41',
                                                                                                              'upstream_sha256': 'bd5d20009f6f9575364ea81dbd46da032beb19effce79137cc3acdb07c861f8a'},
                                                   '.agents/skills/megin-project-knowledge/SKILL.md': {'overlay_sha256': 'c79b5249b8b604163783c4153ca7316522fdfc01d19f3d566e244d8e9a569daa',
                                                                                                       'upstream_sha256': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1'},
                                                   '.agents/skills/megin-requirements-discovery/SKILL.md': {'overlay_sha256': 'f3ac9cc43a3907d587b9442972a6c6676d3ca75c4583ef3195efa295ebc1aae1',
                                                                                                            'upstream_sha256': '76eb90a15cdedc70fa6283b7082444c65e08241caa8b29c58efa9cca6d43f589'},
                                                   '.agents/skills/megin-technical-planning/SKILL.md': {'overlay_sha256': '35bc74ab0bd40d29569e603e36a564cb9ad381ccd189a9629ee297f69f45cf5c',
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
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                                                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'bd435317c2d83926b42a3e9322c6749dc32c5477fb934639eb1fa7074bfb8849',
                                                         '.agents/skills/merge-reviewer/references/native-review.md': '34958c9843041b806e512f95ca455b29130c8953a860dd379e1d2b7051994597',
                                                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': 'ec17398cf4df3d44352cf39cc74afc277158d5ba342f3a00082f8414f7ab485e',
                                                         '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': 'fe61b1a80ef4e7a201fe3b6df28092dbd6daaa77370a2958c0054005514750fd',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '6cbc505ab59a2ca74fa9f102aa7fa142000f3e04f9460ed79e76c69f835ed3e2'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '090e68cad120c988cfddb48a44ae5372c85d31b8891b2fc911366f18b77c47fd',
                                                                                                       'upstream_sha256': '7734810f9d1674eeffc8f435c2d57c261e9de3c25cf731b61634ef11c8fc374f'},
                                                            '.agents/skills/merge-reviewer/scripts/git_review_context.py': {'overlay_sha256': 'd07a606b0a1ad1664923e8758cd320665ee53cbb213c6357305aa3adbfda9f1b',
                                                                                                                            'upstream_sha256': '9ce0a525b58ad0693ab7e39e6de821d5a87c2876972b7a8472af0236b303ab10'}}}},
               'payloadSha256': 'ff1f8452ef10f2b1e947a888fb6f66efe97606dcf899cc710050a1d414e9d63a',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'bbdfcad4b0d29be4a736c050f85f56a28ccac7cebbded19567d45b15c7d3ce89',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'baae8d598252ddb2daf741d8922eac8c4404c2d6badbfbe5435d5b275a400450'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
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
                                               'version': '0.7.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.1.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '7f7b3486e46f190eb5e4b92f0c35b25f10e40fd6ece0a6f3764d48783431a646',
                                                 'version': '0.1.0'}},
               'version': '0.17.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'e593253c7bb29364780f085ebf4609e11cc261c0bf44dbb8067f509217e9f97a',
                             '.agents/skills/codebase-wiki/VERSION': '40b8eb4000a913a7791090535f291d3d369874162a89ef3c9e3d4e887a1b9e79',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '70dc9a02b4bedf81945b486bdbc4afd47b8ae72c62aa76022cbfcb883e9947eb',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '355dce15a4749863d59d14042f4f6352b9e333f4c5ab40e66762c190a4a4902a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '4050ec34edb6f6e327aed9a523257d8ea561b5f93be81e751a1d5a234e2f5514',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': 'f4b4c6717b8e37543807cd6176053dc1c14dd738e62859626b266dbfce404b17',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'development-spec',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-workflow',
                                'merge-quick',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '02aa0daad3fb3b8442c3bf6c8be10b394f25c493a9ab6a372842a1a59ec9c721',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': '900b19674c59db08c39c6e8689616009354df060c45daab717fd7c4f196444f1',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': 'ba37595ff65c8f696a17262532314337669cd3c5d9a1bd80d7ca90948d145629',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': 'f91be08047b952131f20b0b08b1dfd370876ffe610601c4bb35ef652aa38eebe',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': 'bd5d20009f6f9575364ea81dbd46da032beb19effce79137cc3acdb07c861f8a',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': '76eb90a15cdedc70fa6283b7082444c65e08241caa8b29c58efa9cca6d43f589',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'ff55c9bdcbde00736a336c3b4456f4359b19feb09b9a3daa57dde0b6b24741f0',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'dddc871fe1654a3253d0182c285e16cb5bc83e6d7e0f729ec7033f979b0f4d15',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '69a9ddd32ea42b707b94a21c74f41b96beed53b1c98188dffe4e268996402d7e',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': 'c2dbfc5b17f5606eada8f86f2da942981f0461602ca1971d95cb9deda904636d',
                         '.agents/skills/megin/agents/openai.yaml': 'e83f14a0b245b81ada931689895269562510490fda4362df8e6ce56cec906ceb',
                         '.agents/skills/megin/references/branch-policy.md': '9d5f0904b6c32b7131ee2f75d558b9ff78852367a0fcaeec87924eea7ae708b8',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/quality-gates.md': 'cb194dd81a01aa1076357851e019ec11aa5c9a92c491bffeacea2feee93a3ec7',
                         '.agents/skills/megin/references/repository-workflow.md': '5fd4e868756ee7c94833edd6d74d213a130186a86f08d1615caa4711452ad092',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'd75d8865cc2f4d9135c778bd201cfb240e2b613a00dfe4e4a476256bcb3ab32a',
                         '.agents/skills/megin/references/requirements-template.md': '4eb84aed20fc8053ac04102cc6ba0bcb875147b4cb9b282da5cea3f7c0e4e36b',
                         '.agents/skills/megin/references/workflow-record.md': '900bd5e07dd834d44e3dcad8cc4239e0e726c0a277b07b0fc8cea00633ed0b95',
                         '.agents/skills/megin/scripts/quality_gate.py': 'a5d9c43b679fe8d04d9b918166282fbbc66b6190a72309706a62de9bafcc3378',
                         '.agents/skills/megin/scripts/repo_workspace.py': 'c757393d71231c5696dbe27a0847e6c696ef90c045aca555c764334f601c8f3b',
                         '.agents/skills/megin/scripts/validate_skills.py': '60e1ae420eb79e1a547cecd63a267851669cf838aae794563fa9e4ee0874616e',
                         '.agents/skills/merge-reviewer/SKILL.md': '7734810f9d1674eeffc8f435c2d57c261e9de3c25cf731b61634ef11c8fc374f',
                         '.agents/skills/merge-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'c7351c91341da5cca4a60c0df69451c389a53dcd2f8977c134e493291fb39f45',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '9ce0a525b58ad0693ab7e39e6de821d5a87c2876972b7a8472af0236b303ab10',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'd4912998f5dd444df86ef43488169f8b1f4343e9f62d448c9fbbd741ba1f63de',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/release-reviewer/SKILL.md': 'c71626fbbf52201eb6066181ac5669f10ecfa0279fdb2d67c1bad6da22eaa98f',
                         '.agents/skills/release-reviewer/VERSION': 'e9dd8507f4bf0c6f42458e41aea833ad0bd3f6127272335eee9bf4d58541ed67',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '4e104534e21a9be419d34c761bb2d0c4af89e1cb4067576a071d6d654a800ada',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'bc4972f0a80d70f5aa532de9d0e8182983672b87eb21c5111033b2e39dc9e4d0',
                         '.agents/skills/release-reviewer/scripts/evidence.py': 'a95377326f41785f4fd8184eab6d5ced9cd968400b945fd1584236b98412f09e',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '28fbdfb4aa545edbf91b7839405c3b624df2be5e56acc86138fcf2695251f870',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'c3f36b06abf283bc8d6384491d25d41f4ef1c74fcb9a9cb63fbf3418fe3790dc',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '48a00d60194632544c63698ac3becef88962ebbd6c4756a187c6a28346c93083',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {},
               'payloadSha256': '6ea745320421b05f5d32ce3ec9224d4b658e8a47436429780d4fe17f97d8b3f5',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '8b040910804b6949f8d4b04b9c9acbb5e31cc48647ab177fbf51a53eb29c2a1d',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'd2d7168ef30d6fdd83db83839482550a36857988851fc0545126dd223d5e5760'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
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
                                               'version': '0.7.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.1.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '7f7b3486e46f190eb5e4b92f0c35b25f10e40fd6ece0a6f3764d48783431a646',
                                                 'version': '0.1.0'}},
               'version': '0.17.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '654b4bd8444eaa36b96e49eb498b6c37ce0b6b65ba1d4a48cb2a9c11992e5e85',
                             '.agents/skills/codebase-wiki/VERSION': 'd915cc95d6ca8f47ae297713ed46d4e5c5d99ddd29fc3c61e263bdf305f2b5b0',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '70dc9a02b4bedf81945b486bdbc4afd47b8ae72c62aa76022cbfcb883e9947eb',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '355dce15a4749863d59d14042f4f6352b9e333f4c5ab40e66762c190a4a4902a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '4050ec34edb6f6e327aed9a523257d8ea561b5f93be81e751a1d5a234e2f5514',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '9a10015a1d7aababa60a1f09dfcdf12628927c9578ff63fd0ab4145a0c7cce8a',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'development-spec',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-workflow',
                                'merge-group',
                                'merge-mr',
                                'merge-quick',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': '3945f9f230cdcada32b82f4b41fad9f1df513fac5cca2a36d95ce530d58724cd',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '9a5a136654ad13b1f18b788f3c5f2cd77d6edb0c54a149b8b3112bf0cecce26a',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': '01f42c3975ceab232f92bf552aee77e128e5bbac26df9af3846e719ea63b521f',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '92e39c1e825bc6a25aa8de381731bf4ef80c05d5e4bdd5853bd1c26a7095d9d5',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '78d2b425c55fbdf29d60ef8d02c478bd14321b275c2aecaa6e207310032cafbc',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '0dbe03ad44af82d33218c76b9d10a2aad38301a26ea6e0d1b5698746b58644d6',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '7918385972dde8182b4a6c6b0e17702026ebe694aa47a58f0d3385ed10f7c7dd',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': 'a8354017a6170b47c956b4c8cdf6ba7327833a39e7556f09f7b25000207e18a1',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': '4cf9f637c0d629eeeb73379abe7b2e3a760f7f2db06255db30ef8a1454785f55',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': '64b4b8c8a3698dc50faa7b5f3474be227fa22c419571d813cb5f65a571ad9fb3',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': 'c834a99c3d291a020eff000b349e6c9b746466a562564e961b345797d03c85b8',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '34c523bbe0b2af5bc86fa5253c19f4db01109a6188f6ce1c68074b928da65e89',
                         '.agents/skills/megin/agents/openai.yaml': 'e83f14a0b245b81ada931689895269562510490fda4362df8e6ce56cec906ceb',
                         '.agents/skills/megin/references/branch-policy.md': '68f79b691f41a4a3db54b7d1b844fc97596121bebcc1d3241e463c858482a61c',
                         '.agents/skills/megin/references/cross-flow-delivery.md': 'a0b342fe0d156c2583c96b19f8caffde1a4941690e88ebdad9ba7e5e79268bad',
                         '.agents/skills/megin/references/cross-repo-evidence.md': '03b10cde95ddf690691f39426aa713106d437c530031cc724fd84c45ef11dbc4',
                         '.agents/skills/megin/references/delivery-receipts.md': '839bc8b8a6eaa942bf8a49a2c2d77692c44d3c29117dc515303f9745f3e3f287',
                         '.agents/skills/megin/references/gitlab-delivery.md': '95d7e0a1bf063cea3be829b3eb38b4da1d5d6f365fcabca3310b30ab4532aed1',
                         '.agents/skills/megin/references/group-workspace.md': 'a1a8d173e113d7af7fe8a490dc390e95cebf4e38aac81446ae8972e80ba88163',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '587e90fa533c3e0eb5fe7fda8a64db18c92017f676292f16b01211829b7312e4',
                         '.agents/skills/megin/references/quality-gates.md': '9699b54b3ac71f670527b4ce48a41cb19ad29262297ceed76ca35839da89c11a',
                         '.agents/skills/megin/references/repository-workflow.md': 'db061b1d6cfe8db136516e4c801fc5a1327e2093221eb1fb3e5b88d649bd4dac',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': '6bb694f70a9e834d6966233304dfdd07de0521207d102feef170c92b0db84df6',
                         '.agents/skills/megin/references/requirements-template.md': '9cb21e1ea2f1776ee3bd3d0d677e51838c9279d8db93d2c781d61e2d0ca21061',
                         '.agents/skills/megin/references/verification-extensions.md': '925e25d06f4f869eb2b26846079bfa63c76818ba8f15f4a8bfd38eea23fcf3cd',
                         '.agents/skills/megin/references/workflow-record.md': 'dd58e205f3ba2c6b71a6aedba949e0b400218f026a1b9151f0747500acc8cebd',
                         '.agents/skills/megin/scripts/behavior_trace.py': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '39f90d3cae5b3978474ae8e63361a3cee4b4654541dce2c8bbc33f5b41e9ba67',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                         '.agents/skills/megin/scripts/group_quality_gate.py': '2feddc4b5ffb83d0d40224aedc33481844755191d8c2a9efd12c20c37cd908c5',
                         '.agents/skills/megin/scripts/group_workspace.py': 'bef7fdfba95cc6d6af638cbb3de0d644249571fa51bcdd312957b3112456370f',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': 'a259e629a06e5a608c6c3571fad57c9bc35658fe39a307766c7abb2bf46a1887',
                         '.agents/skills/megin/scripts/quality_policy.py': '80ee3fa547d7c59eb9a336a36e952c2796bcd0b8999beafc3e3844a04205941f',
                         '.agents/skills/megin/scripts/repo_workspace.py': '45c752435197ce0053b7ac249243f426ba60a6790ba27e6b679054c07abb8061',
                         '.agents/skills/megin/scripts/review_history.py': '75759b859f21ae249428ebbaa24f89821b68239e9c3be95c7a908829aecdc94f',
                         '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                         '.agents/skills/megin/scripts/validate_skills.py': '60e1ae420eb79e1a547cecd63a267851669cf838aae794563fa9e4ee0874616e',
                         '.agents/skills/megin/scripts/verification_inputs.py': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                         '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b',
                         '.agents/skills/merge-reviewer/SKILL.md': '4fe05f4bd9002c59c7eff5c1d37e1198a2ab8f49d27212a1601d7d831a7e5d11',
                         '.agents/skills/merge-reviewer/VERSION': '9d8c94f1ad3ea96b1e2ac4914fda4cb93c76b4a3e0d8cc6dd8976d6c0b227d15',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'c7351c91341da5cca4a60c0df69451c389a53dcd2f8977c134e493291fb39f45',
                         '.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                         '.agents/skills/merge-reviewer/references/megin-receipt.md': '64b91596ecfa0284b76ca73bb88be0b02dc602163eec666baad1a67b847920c3',
                         '.agents/skills/merge-reviewer/references/mr-contract.md': '77159dcff95e551b71f2d4b58299a0ac50f34458daabe3681ed28679ca487027',
                         '.agents/skills/merge-reviewer/references/native-review.md': '037e1026042771b534bbd6717343a740cdb8cad0c0f0b515a45055338f7c2d11',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
                         '.agents/skills/merge-reviewer/scripts/behavior_trace.py': 'd802a8804e36af404c3ddaa6c998ff5e434e2d55f4263518815aed78e32e131d',
                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': '7aaf3ea61ac99d4e52b1c0e849c25f11ebec38edb88ecbc6605fa86ffbfe1845',
                         '.agents/skills/merge-reviewer/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '8257fdf6c5b154c46d630dd5d2edb3d0338e538484f8e29ad8c238e00a14cdb3',
                         '.agents/skills/merge-reviewer/scripts/group_delivery_binding.py': '943e49cc5d3eeaa9d3a472dfe661d623b0a38471b4c05c145f436dd2e1e248e3',
                         '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': '8c98864935d1fd4c8946207a0dac8d5b1d6ebf7cf3ff96d4b451b862fa4bd965',
                         '.agents/skills/merge-reviewer/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/merge-reviewer/scripts/quality_policy.py': '80ee3fa547d7c59eb9a336a36e952c2796bcd0b8999beafc3e3844a04205941f',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '1abde87eccf8f99657b9964d122c1b6041a08ab26bb20d6de09f9a4c990dd63a',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/verification_inputs.py': 'f014d2b9f56d1b6bbddcfe570dc4b72f1469252ba77ebfc98630fe4c139900dd',
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '2add557a423f03fad42217b2728dcd0cc2261e38aa19db6640fb3275ff9af712',
                         '.agents/skills/release-reviewer/SKILL.md': 'c71626fbbf52201eb6066181ac5669f10ecfa0279fdb2d67c1bad6da22eaa98f',
                         '.agents/skills/release-reviewer/VERSION': 'e9dd8507f4bf0c6f42458e41aea833ad0bd3f6127272335eee9bf4d58541ed67',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '4e104534e21a9be419d34c761bb2d0c4af89e1cb4067576a071d6d654a800ada',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'bc4972f0a80d70f5aa532de9d0e8182983672b87eb21c5111033b2e39dc9e4d0',
                         '.agents/skills/release-reviewer/scripts/evidence.py': 'a95377326f41785f4fd8184eab6d5ced9cd968400b945fd1584236b98412f09e',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '28fbdfb4aa545edbf91b7839405c3b624df2be5e56acc86138fcf2695251f870',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'c3f36b06abf283bc8d6384491d25d41f4ef1c74fcb9a9cb63fbf3418fe3790dc',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '48a00d60194632544c63698ac3becef88962ebbd6c4756a187c6a28346c93083',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'eb44f9439416c0ef7f9e2e7e5ef486f937d6f5dfffcbc41bcb2633729e86c275',
                                                                                                     'upstream_sha256': '56c3b7c69cab3d16522190fe9c680617abce94d384548b55e2e3b2932b029ba6'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                                                                                                                                'upstream_sha256': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                                                                                                                                    'upstream_sha256': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                                                                                                                                 'upstream_sha256': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994'}}},
                            'megin': {'added': {'.agents/skills/megin/references/cross-flow-delivery.md': 'a0b342fe0d156c2583c96b19f8caffde1a4941690e88ebdad9ba7e5e79268bad',
                                                '.agents/skills/megin/references/cross-repo-evidence.md': '03b10cde95ddf690691f39426aa713106d437c530031cc724fd84c45ef11dbc4',
                                                '.agents/skills/megin/references/gitlab-delivery.md': '95d7e0a1bf063cea3be829b3eb38b4da1d5d6f365fcabca3310b30ab4532aed1',
                                                '.agents/skills/megin/references/group-workspace.md': 'a1a8d173e113d7af7fe8a490dc390e95cebf4e38aac81446ae8972e80ba88163',
                                                '.agents/skills/megin/scripts/gitlab_delivery.py': '556308cee1c919ad86d4d8a083e14cb2e1ea40563c8e2fa60b763a616096fe6e',
                                                '.agents/skills/megin/scripts/group_quality_gate.py': '2feddc4b5ffb83d0d40224aedc33481844755191d8c2a9efd12c20c37cd908c5',
                                                '.agents/skills/megin/scripts/group_workspace.py': 'bef7fdfba95cc6d6af638cbb3de0d644249571fa51bcdd312957b3112456370f',
                                                '.agents/skills/megin/scripts/simulation_policy.py': '110da648ce3c0cdc696fe59f5a8bd4abf7acee3b204ff1ee904c1967456a1b44',
                                                '.agents/skills/megin/scripts/workspace_extension.py': 'a12570a3b637a3ee62c759783da7aefbaabcbfa6fe9a50451bc5a80119b4a76b'},
                                      'replaced': {'.agents/skills/megin-behavior-contract/SKILL.md': {'overlay_sha256': '3945f9f230cdcada32b82f4b41fad9f1df513fac5cca2a36d95ce530d58724cd',
                                                                                                       'upstream_sha256': 'ab1fdcf76cd8aa06f2c8eaeda1f5ae4f75779430cab45c8f7f62f76d16c840bf'},
                                                   '.agents/skills/megin-bug-diagnosis/SKILL.md': {'overlay_sha256': '9a5a136654ad13b1f18b788f3c5f2cd77d6edb0c54a149b8b3112bf0cecce26a',
                                                                                                   'upstream_sha256': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac'},
                                                   '.agents/skills/megin-code-review/SKILL.md': {'overlay_sha256': '01f42c3975ceab232f92bf552aee77e128e5bbac26df9af3846e719ea63b521f',
                                                                                                 'upstream_sha256': 'ed62be6d81dedaa91ffc7ebe15ecbdcdbec40ac22cc19291af20dffd20823883'},
                                                   '.agents/skills/megin-finishing-delivery/SKILL.md': {'overlay_sha256': '92e39c1e825bc6a25aa8de381731bf4ef80c05d5e4bdd5853bd1c26a7095d9d5',
                                                                                                        'upstream_sha256': '46efddf0b131cdf58acbc3890d44a328303cb6ba0fdb54d24a63d01560cd14b6'},
                                                   '.agents/skills/megin-human-acceptance/SKILL.md': {'overlay_sha256': '78d2b425c55fbdf29d60ef8d02c478bd14321b275c2aecaa6e207310032cafbc',
                                                                                                      'upstream_sha256': '49cb3a7f95e33e5abf33d6ac651c641b143943a75572a59ef36a174eae173dcb'},
                                                   '.agents/skills/megin-implementation-execution/SKILL.md': {'overlay_sha256': '0dbe03ad44af82d33218c76b9d10a2aad38301a26ea6e0d1b5698746b58644d6',
                                                                                                              'upstream_sha256': 'c0079b9211cb17af3ef4c5aea9f778ad321e37f868c989dc74586739c3bde55a'},
                                                   '.agents/skills/megin-project-knowledge/SKILL.md': {'overlay_sha256': '7918385972dde8182b4a6c6b0e17702026ebe694aa47a58f0d3385ed10f7c7dd',
                                                                                                       'upstream_sha256': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1'},
                                                   '.agents/skills/megin-requirements-discovery/SKILL.md': {'overlay_sha256': 'a8354017a6170b47c956b4c8cdf6ba7327833a39e7556f09f7b25000207e18a1',
                                                                                                            'upstream_sha256': 'f2e1d71753dac0b4dcced0d4ee6895d4df38c5e25265b2bea8ae3db5d011eec5'},
                                                   '.agents/skills/megin-technical-planning/SKILL.md': {'overlay_sha256': '4cf9f637c0d629eeeb73379abe7b2e3a760f7f2db06255db30ef8a1454785f55',
                                                                                                        'upstream_sha256': '8ace2dc373f77040d0d81042db0b4dd4260aaa8bf374506fb57f6256ffc553e5'},
                                                   '.agents/skills/megin-test-driven-development/SKILL.md': {'overlay_sha256': '64b4b8c8a3698dc50faa7b5f3474be227fa22c419571d813cb5f65a571ad9fb3',
                                                                                                             'upstream_sha256': '6432b0f16e71b3ba9e8727068a93102b3fad3c24c348dc87b3bf2ad1ba8080fe'},
                                                   '.agents/skills/megin-verification-before-completion/SKILL.md': {'overlay_sha256': 'c834a99c3d291a020eff000b349e6c9b746466a562564e961b345797d03c85b8',
                                                                                                                    'upstream_sha256': '385392e54268277b3ab5eb1fd4353056c460b49d8a29a9e0bb9cecd957017e36'},
                                                   '.agents/skills/megin/SKILL.md': {'overlay_sha256': '34c523bbe0b2af5bc86fa5253c19f4db01109a6188f6ce1c68074b928da65e89',
                                                                                     'upstream_sha256': 'ab12031e44041e8c0d46f226ecd0afaa68b87d2104143b7ae69bd80ada028812'},
                                                   '.agents/skills/megin/references/branch-policy.md': {'overlay_sha256': '68f79b691f41a4a3db54b7d1b844fc97596121bebcc1d3241e463c858482a61c',
                                                                                                        'upstream_sha256': '9d5f0904b6c32b7131ee2f75d558b9ff78852367a0fcaeec87924eea7ae708b8'},
                                                   '.agents/skills/megin/references/language-policy.md': {'overlay_sha256': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                                                                                                          'upstream_sha256': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a'},
                                                   '.agents/skills/megin/references/quality-gates.md': {'overlay_sha256': '9699b54b3ac71f670527b4ce48a41cb19ad29262297ceed76ca35839da89c11a',
                                                                                                        'upstream_sha256': '5c45ae4e12444d46c1ff99c12afe7deefab57cb107b50cd1e4fcd93a49928b40'},
                                                   '.agents/skills/megin/references/requirements-discovery-protocol.md': {'overlay_sha256': '6bb694f70a9e834d6966233304dfdd07de0521207d102feef170c92b0db84df6',
                                                                                                                          'upstream_sha256': '22105bc37630b699f0f4c10a06b7d3e9fd8fb3739fc92f269e263d0124ec5dd4'},
                                                   '.agents/skills/megin/references/requirements-template.md': {'overlay_sha256': '9cb21e1ea2f1776ee3bd3d0d677e51838c9279d8db93d2c781d61e2d0ca21061',
                                                                                                                'upstream_sha256': '4eb84aed20fc8053ac04102cc6ba0bcb875147b4cb9b282da5cea3f7c0e4e36b'},
                                                   '.agents/skills/megin/references/workflow-record.md': {'overlay_sha256': 'dd58e205f3ba2c6b71a6aedba949e0b400218f026a1b9151f0747500acc8cebd',
                                                                                                          'upstream_sha256': '7a7974edc29e4133332ba416560587ae0a2970f4c969bc1680467da4b3686f91'},
                                                   '.agents/skills/megin/scripts/behavior_trace.py': {'overlay_sha256': '94529af3133c21a2f311138fbc64570e2553ce738af1618d957c393542df41ff',
                                                                                                      'upstream_sha256': 'd802a8804e36af404c3ddaa6c998ff5e434e2d55f4263518815aed78e32e131d'},
                                                   '.agents/skills/megin/scripts/delivery_receipt.py': {'overlay_sha256': '39f90d3cae5b3978474ae8e63361a3cee4b4654541dce2c8bbc33f5b41e9ba67',
                                                                                                        'upstream_sha256': '1b9d35339250d32624c79c55f02fde17067bb6dab0e8bf5c1be24d1412565547'},
                                                   '.agents/skills/megin/scripts/verification_inputs.py': {'overlay_sha256': '5a90b2143b017e748543f9db31a012d10a636cc4ddff373ab9c6ba6b4db8df1c',
                                                                                                           'upstream_sha256': 'f014d2b9f56d1b6bbddcfe570dc4b72f1469252ba77ebfc98630fe4c139900dd'}}},
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/group-review.md': '9e6366f97c819741b6c025774b1daf753ed3fec8cafedbaa6f9bad97da8005f6',
                                                         '.agents/skills/merge-reviewer/references/mr-contract.md': '77159dcff95e551b71f2d4b58299a0ac50f34458daabe3681ed28679ca487027',
                                                         '.agents/skills/merge-reviewer/references/native-review.md': '037e1026042771b534bbd6717343a740cdb8cad0c0f0b515a45055338f7c2d11',
                                                         '.agents/skills/merge-reviewer/scripts/group_delivery_binding.py': '943e49cc5d3eeaa9d3a472dfe661d623b0a38471b4c05c145f436dd2e1e248e3',
                                                         '.agents/skills/merge-reviewer/scripts/group_review.py': '11ace52161f37259b273eb5abcacbbd298aad20155b4ce185cc78f1a25b53903',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': '8c98864935d1fd4c8946207a0dac8d5b1d6ebf7cf3ff96d4b451b862fa4bd965',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': '2add557a423f03fad42217b2728dcd0cc2261e38aa19db6640fb3275ff9af712'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '4fe05f4bd9002c59c7eff5c1d37e1198a2ab8f49d27212a1601d7d831a7e5d11',
                                                                                                       'upstream_sha256': '7e00a6caf17b6be5e639fa741a36c534206df4419e41f3ae70e9012eb056d652'}}}},
               'payloadSha256': 'b69edd4d6808c407a836a282661a637c42155535c6ff37c66d03a60500d94815',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'a733e6242740d9435c43fdc09f27749b17b3b961f5faac5b0902437fa389c282',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': '1c9d1ef97f5dc5be5337c12020c975dee1825ac6d7e239807a707ad507d57961'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'cf13488ad93459438e43051ce8a3bd1a4bf0c2f1c1e47152a0d83bc7f95b05e1',
                                              'version': '0.5.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '7cbe18d8403500ddf64f27105d615985f47fbae3359cf6b485bfff1ccd7d910f',
                                      'version': '0.6.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.9.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'd91becfaf01c8d6aaf00fcd087e8bf4406fb691ec90ddc8073c82c4d10fbfe0b',
                                               'version': '0.9.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.1.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '7f7b3486e46f190eb5e4b92f0c35b25f10e40fd6ece0a6f3764d48783431a646',
                                                 'version': '0.1.0'}},
               'version': '0.18.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'eb44f9439416c0ef7f9e2e7e5ef486f937d6f5dfffcbc41bcb2633729e86c275',
                             '.agents/skills/codebase-wiki/VERSION': 'a0ad50640139a524f86591157145bf1d4674ea9c065bfea21558f0f7b04430c8',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '2c8d56a091f389749fe6040a566d3438b296cdfee126b8d093764641f7294f98',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '456f926c0f5d06fee9ec5e5ce693603f58943252d697f5fae4152c1e24d388b8',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': '4ceb35f77da9b97a4f77eb59ed600e0febddbbe658562595e25221875871266d',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '025492c294139c860332426191b62f866fb5dd5acd1580cdbc591cfed70b80fc',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'da441eb51e35a68f08ed74ca94e63c6d961cd217a99126d6c766bf7a4d294dad',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '491b35b9abfd968963460b47eb1fef48d834ee0d9092d820c44bad19a25d011c',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'development-spec',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-workflow',
                                'merge-quick',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'files': {'.agents/skills/megin-behavior-contract/SKILL.md': 'ab1fdcf76cd8aa06f2c8eaeda1f5ae4f75779430cab45c8f7f62f76d16c840bf',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '1cfb5386e5b0a8e01d2a645b3f365e279908cfc053f850e553cf758e991b85ac',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'ed62be6d81dedaa91ffc7ebe15ecbdcdbec40ac22cc19291af20dffd20823883',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '46efddf0b131cdf58acbc3890d44a328303cb6ba0fdb54d24a63d01560cd14b6',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '49cb3a7f95e33e5abf33d6ac651c641b143943a75572a59ef36a174eae173dcb',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': 'c0079b9211cb17af3ef4c5aea9f778ad321e37f868c989dc74586739c3bde55a',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '886a41740a1945f114284b0e5e468a125e4b2663ad3cd26bd7856d4bb7af31c1',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': 'f2e1d71753dac0b4dcced0d4ee6895d4df38c5e25265b2bea8ae3db5d011eec5',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': '8ace2dc373f77040d0d81042db0b4dd4260aaa8bf374506fb57f6256ffc553e5',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': '6432b0f16e71b3ba9e8727068a93102b3fad3c24c348dc87b3bf2ad1ba8080fe',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '385392e54268277b3ab5eb1fd4353056c460b49d8a29a9e0bb9cecd957017e36',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': 'ab12031e44041e8c0d46f226ecd0afaa68b87d2104143b7ae69bd80ada028812',
                         '.agents/skills/megin/agents/openai.yaml': 'e83f14a0b245b81ada931689895269562510490fda4362df8e6ce56cec906ceb',
                         '.agents/skills/megin/references/branch-policy.md': '9d5f0904b6c32b7131ee2f75d558b9ff78852367a0fcaeec87924eea7ae708b8',
                         '.agents/skills/megin/references/delivery-receipts.md': '839bc8b8a6eaa942bf8a49a2c2d77692c44d3c29117dc515303f9745f3e3f287',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '587e90fa533c3e0eb5fe7fda8a64db18c92017f676292f16b01211829b7312e4',
                         '.agents/skills/megin/references/quality-gates.md': '5c45ae4e12444d46c1ff99c12afe7deefab57cb107b50cd1e4fcd93a49928b40',
                         '.agents/skills/megin/references/repository-workflow.md': 'db061b1d6cfe8db136516e4c801fc5a1327e2093221eb1fb3e5b88d649bd4dac',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': '22105bc37630b699f0f4c10a06b7d3e9fd8fb3739fc92f269e263d0124ec5dd4',
                         '.agents/skills/megin/references/requirements-template.md': '4eb84aed20fc8053ac04102cc6ba0bcb875147b4cb9b282da5cea3f7c0e4e36b',
                         '.agents/skills/megin/references/verification-extensions.md': '925e25d06f4f869eb2b26846079bfa63c76818ba8f15f4a8bfd38eea23fcf3cd',
                         '.agents/skills/megin/references/workflow-record.md': '7a7974edc29e4133332ba416560587ae0a2970f4c969bc1680467da4b3686f91',
                         '.agents/skills/megin/scripts/behavior_trace.py': 'd802a8804e36af404c3ddaa6c998ff5e434e2d55f4263518815aed78e32e131d',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '1b9d35339250d32624c79c55f02fde17067bb6dab0e8bf5c1be24d1412565547',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': 'a259e629a06e5a608c6c3571fad57c9bc35658fe39a307766c7abb2bf46a1887',
                         '.agents/skills/megin/scripts/quality_policy.py': '80ee3fa547d7c59eb9a336a36e952c2796bcd0b8999beafc3e3844a04205941f',
                         '.agents/skills/megin/scripts/repo_workspace.py': '45c752435197ce0053b7ac249243f426ba60a6790ba27e6b679054c07abb8061',
                         '.agents/skills/megin/scripts/review_history.py': '75759b859f21ae249428ebbaa24f89821b68239e9c3be95c7a908829aecdc94f',
                         '.agents/skills/megin/scripts/validate_skills.py': '60e1ae420eb79e1a547cecd63a267851669cf838aae794563fa9e4ee0874616e',
                         '.agents/skills/megin/scripts/verification_inputs.py': 'f014d2b9f56d1b6bbddcfe570dc4b72f1469252ba77ebfc98630fe4c139900dd',
                         '.agents/skills/merge-reviewer/SKILL.md': '7e00a6caf17b6be5e639fa741a36c534206df4419e41f3ae70e9012eb056d652',
                         '.agents/skills/merge-reviewer/VERSION': '9d8c94f1ad3ea96b1e2ac4914fda4cb93c76b4a3e0d8cc6dd8976d6c0b227d15',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'c7351c91341da5cca4a60c0df69451c389a53dcd2f8977c134e493291fb39f45',
                         '.agents/skills/merge-reviewer/references/megin-receipt.md': '64b91596ecfa0284b76ca73bb88be0b02dc602163eec666baad1a67b847920c3',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
                         '.agents/skills/merge-reviewer/scripts/behavior_trace.py': 'd802a8804e36af404c3ddaa6c998ff5e434e2d55f4263518815aed78e32e131d',
                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': '7aaf3ea61ac99d4e52b1c0e849c25f11ebec38edb88ecbc6605fa86ffbfe1845',
                         '.agents/skills/merge-reviewer/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '8257fdf6c5b154c46d630dd5d2edb3d0338e538484f8e29ad8c238e00a14cdb3',
                         '.agents/skills/merge-reviewer/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/merge-reviewer/scripts/quality_policy.py': '80ee3fa547d7c59eb9a336a36e952c2796bcd0b8999beafc3e3844a04205941f',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '1abde87eccf8f99657b9964d122c1b6041a08ab26bb20d6de09f9a4c990dd63a',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/verification_inputs.py': 'f014d2b9f56d1b6bbddcfe570dc4b72f1469252ba77ebfc98630fe4c139900dd',
                         '.agents/skills/release-reviewer/SKILL.md': 'c71626fbbf52201eb6066181ac5669f10ecfa0279fdb2d67c1bad6da22eaa98f',
                         '.agents/skills/release-reviewer/VERSION': 'e9dd8507f4bf0c6f42458e41aea833ad0bd3f6127272335eee9bf4d58541ed67',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '4e104534e21a9be419d34c761bb2d0c4af89e1cb4067576a071d6d654a800ada',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'bc4972f0a80d70f5aa532de9d0e8182983672b87eb21c5111033b2e39dc9e4d0',
                         '.agents/skills/release-reviewer/scripts/evidence.py': 'a95377326f41785f4fd8184eab6d5ced9cd968400b945fd1584236b98412f09e',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '28fbdfb4aa545edbf91b7839405c3b624df2be5e56acc86138fcf2695251f870',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'c3f36b06abf283bc8d6384491d25d41f4ef1c74fcb9a9cb63fbf3418fe3790dc',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '48a00d60194632544c63698ac3becef88962ebbd6c4756a187c6a28346c93083',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {},
               'payloadSha256': 'e8d619c4b882b0546ea43638ab6562a25995815d024e88cc6a611ed989da5930',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': 'bbe749a36da074e1283680d14740c3296b098ec8068ec7210982bba1bd98c7a1',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'de0814d33b826c1828c49e9a7cc878a9f92b3e909cc3ddd6721aa5af414e9fb9'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'cf13488ad93459438e43051ce8a3bd1a4bf0c2f1c1e47152a0d83bc7f95b05e1',
                                              'version': '0.5.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '7cbe18d8403500ddf64f27105d615985f47fbae3359cf6b485bfff1ccd7d910f',
                                      'version': '0.6.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.9.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'd91becfaf01c8d6aaf00fcd087e8bf4406fb691ec90ddc8073c82c4d10fbfe0b',
                                               'version': '0.9.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.1.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '7f7b3486e46f190eb5e4b92f0c35b25f10e40fd6ece0a6f3764d48783431a646',
                                                 'version': '0.1.0'}},
               'version': '0.18.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '56c3b7c69cab3d16522190fe9c680617abce94d384548b55e2e3b2932b029ba6',
                             '.agents/skills/codebase-wiki/VERSION': 'a0ad50640139a524f86591157145bf1d4674ea9c065bfea21558f0f7b04430c8',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '0a1de5be1ec5d5818bbdd420add45b5d2f1fc0b04cf9be58d24bba97a0770df5',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': '456f926c0f5d06fee9ec5e5ce693603f58943252d697f5fae4152c1e24d388b8',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'f72371bc60eb5f5259726c91b85d85fbe3c242d8daf8050d6f1fc3e43575a965',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '7feee485a8cab4a9975802c1626bfb671e09f45b28c116656ea1ec8b16c2d90a',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'cc88e2563cb4f57118977dffb57937218d35658b1b4b6cfd1930c47e9b9242c9',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '5ee9970c24e25c738985dee46e3adbb71286c1ab9622a728bca3aabe60f70f14',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '025492c294139c860332426191b62f866fb5dd5acd1580cdbc591cfed70b80fc',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '8c750e78a81e3ea1120317923611ff66aabcadbbf16d607fc7d26bfcd948672b',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '9c4181d1a737ff275ac6d4470475f913f697eab164e64bd1a4d78efbca3e941c',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '5ad8dc2ededab69079ba34513058311567da3cfcc7cab020cb96d312f722b5b9',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'd63fc316d9028378751f76a19b4e29c8e1497e31b6771e29fb9e217cfc287994',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'}},
              {'agentBlockSha256': '1f29fb86114daa8744ef56b3a4f496d8263abbb37f8db42de685b45f39018f65',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-group',
                                'merge-mr',
                                'merge-quick',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': 'f7a966dc8bde19695b1cd62c43bb76af8a1766d562e12ffe3d5c024359081eca',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '840755db509a4ae595f8d635caecae29149e96be80453f7395330ce3948dac22',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '52fd528f6c3ebbe098e931a162ce7d8acf67f32f9b93d71699774ce5b0ffebec',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'cc7ad3f1a107bd6c2018e11a698f34b828b15cdc2b8840e1e2c7978bfb1e3688',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '9ff25fc665305ebe051dc332a367acbe959e78e6a385d8ea890596dac9199946',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '15f285f76670db7b36f6e9ca0321761e517251f4572382fbe9c8efb287969289',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '318891b8f013846d0c2665b380e5236fd4b21e94e21a95a1c04484ddf018f47b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4750f827629b7c9be87952d45d5ddcc31fd54ca35b1b5f76b211e733dc9c6733',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': '7e834f5521a9382a97250dc544e50c1bd074f5fff39c93ece362b70a2d401e0d',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'cd71e47d3787d0a9441968fb7583e13b65041c1e530998811863efdb362ea2dc',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd6c86d0f6df2612e958c938133a1c412811ce986de1dc31e536b2f2bf83abb5c',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '85bc93921b8b09d64c6b11ab0e290e4fe1fb60a476265f83402a9bb99509ff1e',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '9e50e0c77f9cfeceddb031f11d195918e291d77cd8bad06c9d113e91a9e04e67',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': 'bc7e125914c37b46cecfc88f8aad97044cac1ef7fde5bb18728d5d6ee7514957',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': '7eada5bbbe850763295dc9f7ebab64aacffb47cc8218b793566cc6ee72bdb78b',
                         '.agents/skills/merge-reviewer/VERSION': '795d6bc79574d2aec03ad9cfec404bb95083c9dd210e6521e0d4199772d28d44',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': '53715b85a75f6f81a6b1a2b56c500348085edeb57f76ac25ff808d2ee1b0562e',
                         '.agents/skills/merge-reviewer/references/group-quick.md': '27f49ee267f929cb9d0b471dd52ad30646f94721ad57065054684a5f3f5d86f9',
                         '.agents/skills/merge-reviewer/references/megin-receipt.md': '38efd8fe1efb2ab409e061016dbc9df9a60ebc38512b0d08e5d7df864c068112',
                         '.agents/skills/merge-reviewer/references/mr-contract.md': 'fc1b3bd10407a9a77350bfa8d224caafe0d7f7ea1004841f18b6316561ad6eb1',
                         '.agents/skills/merge-reviewer/references/native-review.md': '7e00e0d9483321e7512cfe9be1fe81a07f5190c8d519098b775cf1b1aacab2fc',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '6af8bd3b8d1f54165a4236ab7861d33b1e4001b5cb7ff2125662e6a148ce717a',
                         '.agents/skills/merge-reviewer/scripts/behavior_trace.py': 'd802a8804e36af404c3ddaa6c998ff5e434e2d55f4263518815aed78e32e131d',
                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': '27f4f75a4d461ea55fb366ae725a2033d2cfb4d7675d26cf8d29a9bacad9280d',
                         '.agents/skills/merge-reviewer/scripts/delivery_binding_v2.py': 'd176882931776f0e49c08ec6fa2aeb935585f45f469967153145c8ac074b723b',
                         '.agents/skills/merge-reviewer/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'cd054df85d3131826411488f8bd932dd4ba135515beb56efc0a2815f5b435d7f',
                         '.agents/skills/merge-reviewer/scripts/group_delivery_binding.py': 'c6aba6a996f08313b036735c07235455b3fc85eccf1bc264abd0dc1557f776db',
                         '.agents/skills/merge-reviewer/scripts/legacy_group_review.py': '26835f9fbb7ed489c54ca340605589c7a34f21dd26a9def4a282e8dedeca28b0',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/delivery_receipt.py': '7fa8afe8db4191ee2f136ab715cee9f7aa2bffd371f679aeccaaa4b93e5b66b4',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/functional_inventory.py': '98dac875608701019c6e303cee80e189bf051d30b0c2b07e13346ab0106a353e',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/group_quality_gate.py': 'fe9bedc401ea1115cccd9fc8d2c355240509faff2350d2ecad639726de32b83f',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/group_workspace.py': 'fa827983dd323d30019dd1b0391721e6d8b361083fd92af24f7d99800727d685',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/project_scanner.py': 'df027c3c06eea1cf87ce76b2d1a48aeebc8e2283b0f955cc4101251ab901ff88',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/quality_gate.py': '4faccb2fc33d90b6e12b248d4d27fd37da21e7aec6a640eef57bd2145871bb01',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/quality_policy.py': 'e2353f7fac2a5d66ea16418ecb202b22821c3420186340c52b7ded73ac2db585',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/simulation_policy.py': '126db76c9b9588f9bbf8c54e7651d7d4d8f7aa3edc15b5541704baca8f279ed0',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/validate_skills.py': 'b473d6d8860aef848c5021d2e8a2d37ac59b6413e17dbb06934aaa5e1695e9e8',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/verification_inputs.py': '44710185ed46823124b30e3de2e90c2dad0dc5eef6c3a0d3131edf2c4f8d6cc2',
                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/verify.py': '9d536c383c7a5ec5f2a0a80f0742789a27b64e51659fff5497dedd1cf363fd50',
                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': '9086baaca5a63f004ff04eb6187af0df3d4176ad2f2f1adc647b72a63bc5e6d3',
                         '.agents/skills/merge-reviewer/scripts/project_scanner.py': '392716e5ade4a80492dc65ec0d5d81505f5e230ec987da428477cee3c17b60f9',
                         '.agents/skills/merge-reviewer/scripts/quality_policy.py': '80ee3fa547d7c59eb9a336a36e952c2796bcd0b8999beafc3e3844a04205941f',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/THIRD-PARTY-NOTICES.md': 'c1495e10bcfce8b4e3899e0cfd0e528c762f76869d4015cc0e2661ae56488e4d',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/project_scanner.py': 'c2429d3a677e2395d3b0b1da759541de90f94b65fb9f6692b85072c4942e63a7',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/source-manifest.json': 'ed11c6bb8cfb5630ee8441782fd1081a35a3726ad21e27499ea81bfd137b199d',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/LICENSE': 'b80816b0d530b8accb4c2211783790984a6e3b61922c2b5ee92f3372ab2742fe',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/__init__.py': '9eb042d7c0db5d14c2168ec4946e410de5a91c9cce86892f5e4db5e4633c6762',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/_parser.py': 'a412234c86bf710b361e0943276961f0e25fa6d7c36ba7a0e7eec87a3e018c7b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/_re.py': 'a12359fe294523a72112e434d58452a14c9d050affa2417f9927474e4166bfdd',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/_types.py': 'f864c6d9552a929c7032ace654ee05ef26ca75d21b027b801d77e65907138b74',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/py.typed': 'f0f8f2675695a10a5156fb7bd66bafbaae6a13e8d315990af862c792175e6e67',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/verify.py': '1ada243216a9df55decb3c7e96b479c0715d3f97e89dc825010acb8e382b1e67',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'cfca19ae5d00c3bb7faa8a17ab1a7dd2cb79c5240e5803c86d76fd18ca343585',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '29000be66acb42035d673f0cdda3709a9d645b5bd958166039b9b0ed561397dc',
                         '.agents/skills/merge-reviewer/scripts/verification_inputs.py': 'f014d2b9f56d1b6bbddcfe570dc4b72f1469252ba77ebfc98630fe4c139900dd',
                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': 'd36cfa7a24f649170c2200c8d4505f487fa7e410137fdedf8f76a103abe6511e',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'e08ca62faa8f9081e319cb27a558eae867338f5e27c8ecda1833b89c76a321b0',
                         '.agents/skills/release-reviewer/SKILL.md': '64b60cd7d961fa11686fa374332410acf05175af69da25febeac202e5718e105',
                         '.agents/skills/release-reviewer/VERSION': 'd915cc95d6ca8f47ae297713ed46d4e5c5d99ddd29fc3c61e263bdf305f2b5b0',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'ba6643e15ea33f6f827edc13276499bd9207f28ece1c74857b4695c0da57c78f',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '88c8593603299f65b5025ec72d97222f7151c7a1b25331e88dc3b478cc7fe0bf',
                                                                                                     'upstream_sha256': '6fb668d3b0e779bb50f2628cab7f7532d8f94ca57e0de01a7c7bcfa4810d1c7b'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                                                                                                                                'upstream_sha256': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                                                                                                                                    'upstream_sha256': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                                                                                                                                 'upstream_sha256': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4'}}},
                            'merge-reviewer': {'added': {'.agents/skills/merge-reviewer/references/mr-contract.md': 'fc1b3bd10407a9a77350bfa8d224caafe0d7f7ea1004841f18b6316561ad6eb1',
                                                         '.agents/skills/merge-reviewer/references/native-review.md': '7e00e0d9483321e7512cfe9be1fe81a07f5190c8d519098b775cf1b1aacab2fc',
                                                         '.agents/skills/merge-reviewer/scripts/group_delivery_binding.py': 'c6aba6a996f08313b036735c07235455b3fc85eccf1bc264abd0dc1557f776db',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/delivery_receipt.py': '7fa8afe8db4191ee2f136ab715cee9f7aa2bffd371f679aeccaaa4b93e5b66b4',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/functional_inventory.py': '98dac875608701019c6e303cee80e189bf051d30b0c2b07e13346ab0106a353e',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/group_quality_gate.py': 'fe9bedc401ea1115cccd9fc8d2c355240509faff2350d2ecad639726de32b83f',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/group_workspace.py': 'fa827983dd323d30019dd1b0391721e6d8b361083fd92af24f7d99800727d685',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/project_scanner.py': 'df027c3c06eea1cf87ce76b2d1a48aeebc8e2283b0f955cc4101251ab901ff88',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/quality_gate.py': '4faccb2fc33d90b6e12b248d4d27fd37da21e7aec6a640eef57bd2145871bb01',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/quality_policy.py': 'e2353f7fac2a5d66ea16418ecb202b22821c3420186340c52b7ded73ac2db585',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/simulation_policy.py': '126db76c9b9588f9bbf8c54e7651d7d4d8f7aa3edc15b5541704baca8f279ed0',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/validate_skills.py': 'b473d6d8860aef848c5021d2e8a2d37ac59b6413e17dbb06934aaa5e1695e9e8',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/verification_inputs.py': '44710185ed46823124b30e3de2e90c2dad0dc5eef6c3a0d3131edf2c4f8d6cc2',
                                                         '.agents/skills/merge-reviewer/scripts/legacy_receipt_runtime/verify.py': '9d536c383c7a5ec5f2a0a80f0742789a27b64e51659fff5497dedd1cf363fd50',
                                                         '.agents/skills/merge-reviewer/scripts/mr_contract.py': '9086baaca5a63f004ff04eb6187af0df3d4176ad2f2f1adc647b72a63bc5e6d3',
                                                         '.agents/skills/merge-reviewer/scripts/workspace_extension.py': 'd36cfa7a24f649170c2200c8d4505f487fa7e410137fdedf8f76a103abe6511e'},
                                               'replaced': {'.agents/skills/merge-reviewer/SKILL.md': {'overlay_sha256': '7eada5bbbe850763295dc9f7ebab64aacffb47cc8218b793566cc6ee72bdb78b',
                                                                                                       'upstream_sha256': '0e05c1a159cfbb42ccdd8841c025f43880a780010784c5fc9bfab0951329306f'}}}},
               'payloadSha256': '6c2c8b23f157280c9062214875febc2bc40a8240caddfbc1666903ef49ac7bfd',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'c68befb9cfc57ce5c0a3272427b190f32c7f2b763a95c42bdcbe25afd6e99f8b',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': '839bcdca50c206b557e0778cbfe5887113c1b5b4c47af8ff4931faa454cc82c7'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '292c5172f225ddfca5f0212acac3ad33156759cecbb66b0594fb89c6f1080e9a',
                                              'version': '0.6.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '12fc4f6740a76d7924e4c52279e176bd532a5ed8ecb5c80f088c44d5e16e8fde',
                                      'version': '0.8.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.11.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'a452d1ab97328fb83c9de05064a46d57438b0b46d731c58ccae7fdc016799ea8',
                                               'version': '0.11.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'aeee49157e16d876ca5ca9650f51f10448b568b84a8a25c35b2c9028e8960098',
                                                 'version': '0.3.0'}},
               'version': '0.23.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '88c8593603299f65b5025ec72d97222f7151c7a1b25331e88dc3b478cc7fe0bf',
                             '.agents/skills/codebase-wiki/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '04f30fb161dbeb678dc1736514a887b527956a79da7abd16a210031faf6f0312',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce'},
              {'agentBlockSha256': 'f0e9d256503e3135b1a9844b4584c3e3e11a38a444e8d8311722a7b0ca9c60e4',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-quick',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': 'f7a966dc8bde19695b1cd62c43bb76af8a1766d562e12ffe3d5c024359081eca',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '840755db509a4ae595f8d635caecae29149e96be80453f7395330ce3948dac22',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '52fd528f6c3ebbe098e931a162ce7d8acf67f32f9b93d71699774ce5b0ffebec',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'cc7ad3f1a107bd6c2018e11a698f34b828b15cdc2b8840e1e2c7978bfb1e3688',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '9ff25fc665305ebe051dc332a367acbe959e78e6a385d8ea890596dac9199946',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '15f285f76670db7b36f6e9ca0321761e517251f4572382fbe9c8efb287969289',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '318891b8f013846d0c2665b380e5236fd4b21e94e21a95a1c04484ddf018f47b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4750f827629b7c9be87952d45d5ddcc31fd54ca35b1b5f76b211e733dc9c6733',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': '7e834f5521a9382a97250dc544e50c1bd074f5fff39c93ece362b70a2d401e0d',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'cd71e47d3787d0a9441968fb7583e13b65041c1e530998811863efdb362ea2dc',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd6c86d0f6df2612e958c938133a1c412811ce986de1dc31e536b2f2bf83abb5c',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '85bc93921b8b09d64c6b11ab0e290e4fe1fb60a476265f83402a9bb99509ff1e',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '9e50e0c77f9cfeceddb031f11d195918e291d77cd8bad06c9d113e91a9e04e67',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': 'bc7e125914c37b46cecfc88f8aad97044cac1ef7fde5bb18728d5d6ee7514957',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': '0e05c1a159cfbb42ccdd8841c025f43880a780010784c5fc9bfab0951329306f',
                         '.agents/skills/merge-reviewer/VERSION': '795d6bc79574d2aec03ad9cfec404bb95083c9dd210e6521e0d4199772d28d44',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': '53715b85a75f6f81a6b1a2b56c500348085edeb57f76ac25ff808d2ee1b0562e',
                         '.agents/skills/merge-reviewer/references/group-quick.md': '27f49ee267f929cb9d0b471dd52ad30646f94721ad57065054684a5f3f5d86f9',
                         '.agents/skills/merge-reviewer/references/megin-receipt.md': '38efd8fe1efb2ab409e061016dbc9df9a60ebc38512b0d08e5d7df864c068112',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'f167b4d2c7ffc7ba0c8cea96cb8e476e3e208bd8730c42a1e9275ffb59838b6d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '6af8bd3b8d1f54165a4236ab7861d33b1e4001b5cb7ff2125662e6a148ce717a',
                         '.agents/skills/merge-reviewer/scripts/behavior_trace.py': 'd802a8804e36af404c3ddaa6c998ff5e434e2d55f4263518815aed78e32e131d',
                         '.agents/skills/merge-reviewer/scripts/delivery_binding.py': '27f4f75a4d461ea55fb366ae725a2033d2cfb4d7675d26cf8d29a9bacad9280d',
                         '.agents/skills/merge-reviewer/scripts/delivery_binding_v2.py': 'd176882931776f0e49c08ec6fa2aeb935585f45f469967153145c8ac074b723b',
                         '.agents/skills/merge-reviewer/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'cd054df85d3131826411488f8bd932dd4ba135515beb56efc0a2815f5b435d7f',
                         '.agents/skills/merge-reviewer/scripts/legacy_group_review.py': '26835f9fbb7ed489c54ca340605589c7a34f21dd26a9def4a282e8dedeca28b0',
                         '.agents/skills/merge-reviewer/scripts/project_scanner.py': '392716e5ade4a80492dc65ec0d5d81505f5e230ec987da428477cee3c17b60f9',
                         '.agents/skills/merge-reviewer/scripts/quality_policy.py': '80ee3fa547d7c59eb9a336a36e952c2796bcd0b8999beafc3e3844a04205941f',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/THIRD-PARTY-NOTICES.md': 'c1495e10bcfce8b4e3899e0cfd0e528c762f76869d4015cc0e2661ae56488e4d',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/project_scanner.py': 'c2429d3a677e2395d3b0b1da759541de90f94b65fb9f6692b85072c4942e63a7',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/source-manifest.json': 'ed11c6bb8cfb5630ee8441782fd1081a35a3726ad21e27499ea81bfd137b199d',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/LICENSE': 'b80816b0d530b8accb4c2211783790984a6e3b61922c2b5ee92f3372ab2742fe',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/__init__.py': '9eb042d7c0db5d14c2168ec4946e410de5a91c9cce86892f5e4db5e4633c6762',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/_parser.py': 'a412234c86bf710b361e0943276961f0e25fa6d7c36ba7a0e7eec87a3e018c7b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/_re.py': 'a12359fe294523a72112e434d58452a14c9d050affa2417f9927474e4166bfdd',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/_types.py': 'f864c6d9552a929c7032ace654ee05ef26ca75d21b027b801d77e65907138b74',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/tomli/py.typed': 'f0f8f2675695a10a5156fb7bd66bafbaae6a13e8d315990af862c792175e6e67',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/verify.py': '1ada243216a9df55decb3c7e96b479c0715d3f97e89dc825010acb8e382b1e67',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/merge-reviewer/scripts/receipt_runtime/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'cfca19ae5d00c3bb7faa8a17ab1a7dd2cb79c5240e5803c86d76fd18ca343585',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '29000be66acb42035d673f0cdda3709a9d645b5bd958166039b9b0ed561397dc',
                         '.agents/skills/merge-reviewer/scripts/verification_inputs.py': 'f014d2b9f56d1b6bbddcfe570dc4b72f1469252ba77ebfc98630fe4c139900dd',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'e08ca62faa8f9081e319cb27a558eae867338f5e27c8ecda1833b89c76a321b0',
                         '.agents/skills/release-reviewer/SKILL.md': '64b60cd7d961fa11686fa374332410acf05175af69da25febeac202e5718e105',
                         '.agents/skills/release-reviewer/VERSION': 'd915cc95d6ca8f47ae297713ed46d4e5c5d99ddd29fc3c61e263bdf305f2b5b0',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'ba6643e15ea33f6f827edc13276499bd9207f28ece1c74857b4695c0da57c78f',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {},
               'payloadSha256': 'b04a1abd855bde0144763e1db0f324b58014cebc4c70f4df32785316d1b47ddd',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '0aba4795bcab41f95c5395d7d71adbe3ce8a9528559e36a18e09b8e9be67b318',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': '6f084be4f0741754a4cb692f578d156edbc19293cf235d60bf7fc4faed2d5491'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '292c5172f225ddfca5f0212acac3ad33156759cecbb66b0594fb89c6f1080e9a',
                                              'version': '0.6.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '12fc4f6740a76d7924e4c52279e176bd532a5ed8ecb5c80f088c44d5e16e8fde',
                                      'version': '0.8.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.11.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'a452d1ab97328fb83c9de05064a46d57438b0b46d731c58ccae7fdc016799ea8',
                                               'version': '0.11.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'aeee49157e16d876ca5ca9650f51f10448b568b84a8a25c35b2c9028e8960098',
                                                 'version': '0.3.0'}},
               'version': '0.23.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '6fb668d3b0e779bb50f2628cab7f7532d8f94ca57e0de01a7c7bcfa4810d1c7b',
                             '.agents/skills/codebase-wiki/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '04f30fb161dbeb678dc1736514a887b527956a79da7abd16a210031faf6f0312',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce'},
              {'agentBlockSha256': '9b11ce6f74edeaa6ce5f70e0f5414b5583cb55459c23e2ae0684de0bbcc4b3cd',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': 'f7a966dc8bde19695b1cd62c43bb76af8a1766d562e12ffe3d5c024359081eca',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '840755db509a4ae595f8d635caecae29149e96be80453f7395330ce3948dac22',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '52fd528f6c3ebbe098e931a162ce7d8acf67f32f9b93d71699774ce5b0ffebec',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'cc7ad3f1a107bd6c2018e11a698f34b828b15cdc2b8840e1e2c7978bfb1e3688',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '9ff25fc665305ebe051dc332a367acbe959e78e6a385d8ea890596dac9199946',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '15f285f76670db7b36f6e9ca0321761e517251f4572382fbe9c8efb287969289',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '318891b8f013846d0c2665b380e5236fd4b21e94e21a95a1c04484ddf018f47b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4750f827629b7c9be87952d45d5ddcc31fd54ca35b1b5f76b211e733dc9c6733',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': '7e834f5521a9382a97250dc544e50c1bd074f5fff39c93ece362b70a2d401e0d',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'cd71e47d3787d0a9441968fb7583e13b65041c1e530998811863efdb362ea2dc',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd6c86d0f6df2612e958c938133a1c412811ce986de1dc31e536b2f2bf83abb5c',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '85bc93921b8b09d64c6b11ab0e290e4fe1fb60a476265f83402a9bb99509ff1e',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '9e50e0c77f9cfeceddb031f11d195918e291d77cd8bad06c9d113e91a9e04e67',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': 'bc7e125914c37b46cecfc88f8aad97044cac1ef7fde5bb18728d5d6ee7514957',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': '9ce186c4ca9d1f8729511ede17e6c41b3ae868b1ee98c3489542f5af371412bf',
                         '.agents/skills/merge-reviewer/VERSION': '8a932413d42f95082f8323447652379a4885e328329efca3a67ec9c793c09940',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/report-style.md': '69b41024f2a0c696c1ea33881058cb1809ca18eb9c337d255d1be8e541ae0104',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': '5a7e8c928f214e5fd4bf21feebc8c8a1aafec3a294cff7975b0e68c7c6433dd2',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '1fb4843b1d8982a7f3070e5b2cddd5b618ad58a41d3336292004ce2bafba3013',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '72abc53b3fa7b00b55a99645b14f4dad89660b2e08948b768b7bae63e2e8a63d',
                         '.agents/skills/release-reviewer/SKILL.md': '7904ca2d15956c080f4ebdcbc0b138bb7308c3d973a8970af4d106f4d1217235',
                         '.agents/skills/release-reviewer/VERSION': 'd915cc95d6ca8f47ae297713ed46d4e5c5d99ddd29fc3c61e263bdf305f2b5b0',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'ba6643e15ea33f6f827edc13276499bd9207f28ece1c74857b4695c0da57c78f',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '88c8593603299f65b5025ec72d97222f7151c7a1b25331e88dc3b478cc7fe0bf',
                                                                                                     'upstream_sha256': '6fb668d3b0e779bb50f2628cab7f7532d8f94ca57e0de01a7c7bcfa4810d1c7b'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                                                                                                                                'upstream_sha256': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                                                                                                                                    'upstream_sha256': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                                                                                                                                 'upstream_sha256': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4'}}}},
               'payloadSha256': 'b01d4c6c58a371ed061941b96df98b5fca9b273cecc62660289f7b69da0f3188',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': '9eb969cc4c604fed1fdea51ed0140d65a71bb68ecd692312085a7f571381940e',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': '59106cc2eaf0e0ad2bfa444e77811768820b22a1a3b1e3c49d17aacb30232595'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '292c5172f225ddfca5f0212acac3ad33156759cecbb66b0594fb89c6f1080e9a',
                                              'version': '0.6.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '81c530799f72c661bfe56e1c04dedaeb0c4534d5f387363821f85c95ff137ed8',
                                      'version': '0.8.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '560e68155ee77d3e7af8c61c67386fe5a055c299da829a2b21b8875f7297aa49',
                                               'version': '0.12.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a482db2395462c1848d9bdb9b60e7eee781d9bafbe646cad7c715c350c3618a4',
                                                 'version': '0.3.0'}},
               'version': '0.24.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '88c8593603299f65b5025ec72d97222f7151c7a1b25331e88dc3b478cc7fe0bf',
                             '.agents/skills/codebase-wiki/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '04f30fb161dbeb678dc1736514a887b527956a79da7abd16a210031faf6f0312',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce'},
              {'agentBlockSha256': '4f647de11777b57eaf48ceb9ec0e84380f11d2a8772b6ca80d298089b2fe1feb',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': 'f7a966dc8bde19695b1cd62c43bb76af8a1766d562e12ffe3d5c024359081eca',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '840755db509a4ae595f8d635caecae29149e96be80453f7395330ce3948dac22',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '52fd528f6c3ebbe098e931a162ce7d8acf67f32f9b93d71699774ce5b0ffebec',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'cc7ad3f1a107bd6c2018e11a698f34b828b15cdc2b8840e1e2c7978bfb1e3688',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '9ff25fc665305ebe051dc332a367acbe959e78e6a385d8ea890596dac9199946',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '15f285f76670db7b36f6e9ca0321761e517251f4572382fbe9c8efb287969289',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '318891b8f013846d0c2665b380e5236fd4b21e94e21a95a1c04484ddf018f47b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4750f827629b7c9be87952d45d5ddcc31fd54ca35b1b5f76b211e733dc9c6733',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': '7e834f5521a9382a97250dc544e50c1bd074f5fff39c93ece362b70a2d401e0d',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'cd71e47d3787d0a9441968fb7583e13b65041c1e530998811863efdb362ea2dc',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd6c86d0f6df2612e958c938133a1c412811ce986de1dc31e536b2f2bf83abb5c',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '85bc93921b8b09d64c6b11ab0e290e4fe1fb60a476265f83402a9bb99509ff1e',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '9e50e0c77f9cfeceddb031f11d195918e291d77cd8bad06c9d113e91a9e04e67',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': 'bc7e125914c37b46cecfc88f8aad97044cac1ef7fde5bb18728d5d6ee7514957',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': '9ce186c4ca9d1f8729511ede17e6c41b3ae868b1ee98c3489542f5af371412bf',
                         '.agents/skills/merge-reviewer/VERSION': '8a932413d42f95082f8323447652379a4885e328329efca3a67ec9c793c09940',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/report-style.md': '69b41024f2a0c696c1ea33881058cb1809ca18eb9c337d255d1be8e541ae0104',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': '5a7e8c928f214e5fd4bf21feebc8c8a1aafec3a294cff7975b0e68c7c6433dd2',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '1fb4843b1d8982a7f3070e5b2cddd5b618ad58a41d3336292004ce2bafba3013',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '72abc53b3fa7b00b55a99645b14f4dad89660b2e08948b768b7bae63e2e8a63d',
                         '.agents/skills/release-reviewer/SKILL.md': '7904ca2d15956c080f4ebdcbc0b138bb7308c3d973a8970af4d106f4d1217235',
                         '.agents/skills/release-reviewer/VERSION': 'd915cc95d6ca8f47ae297713ed46d4e5c5d99ddd29fc3c61e263bdf305f2b5b0',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'ba6643e15ea33f6f827edc13276499bd9207f28ece1c74857b4695c0da57c78f',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {},
               'payloadSha256': 'd5a83999669c9133d7bf6d3ad20d4ed97a060b4f9ee90963d991da6c5a36ebfa',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': 'e6364cff46e5acdc52dba09187678bc37255a078ac4dac18d0a71ce35a51d80d',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'cd4b5e6da74418172299af1f4a60c48cfc5f2dd59f9ee1228f70e50ff28d6311'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '292c5172f225ddfca5f0212acac3ad33156759cecbb66b0594fb89c6f1080e9a',
                                              'version': '0.6.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '81c530799f72c661bfe56e1c04dedaeb0c4534d5f387363821f85c95ff137ed8',
                                      'version': '0.8.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '560e68155ee77d3e7af8c61c67386fe5a055c299da829a2b21b8875f7297aa49',
                                               'version': '0.12.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a482db2395462c1848d9bdb9b60e7eee781d9bafbe646cad7c715c350c3618a4',
                                                 'version': '0.3.0'}},
               'version': '0.24.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '6fb668d3b0e779bb50f2628cab7f7532d8f94ca57e0de01a7c7bcfa4810d1c7b',
                             '.agents/skills/codebase-wiki/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '04f30fb161dbeb678dc1736514a887b527956a79da7abd16a210031faf6f0312',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce'},
              {'agentBlockSha256': '9b11ce6f74edeaa6ce5f70e0f5414b5583cb55459c23e2ae0684de0bbcc4b3cd',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': 'f7a966dc8bde19695b1cd62c43bb76af8a1766d562e12ffe3d5c024359081eca',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '840755db509a4ae595f8d635caecae29149e96be80453f7395330ce3948dac22',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '52fd528f6c3ebbe098e931a162ce7d8acf67f32f9b93d71699774ce5b0ffebec',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'cc7ad3f1a107bd6c2018e11a698f34b828b15cdc2b8840e1e2c7978bfb1e3688',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '9ff25fc665305ebe051dc332a367acbe959e78e6a385d8ea890596dac9199946',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '15f285f76670db7b36f6e9ca0321761e517251f4572382fbe9c8efb287969289',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '318891b8f013846d0c2665b380e5236fd4b21e94e21a95a1c04484ddf018f47b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4750f827629b7c9be87952d45d5ddcc31fd54ca35b1b5f76b211e733dc9c6733',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': '7e834f5521a9382a97250dc544e50c1bd074f5fff39c93ece362b70a2d401e0d',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'cd71e47d3787d0a9441968fb7583e13b65041c1e530998811863efdb362ea2dc',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd6c86d0f6df2612e958c938133a1c412811ce986de1dc31e536b2f2bf83abb5c',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '85bc93921b8b09d64c6b11ab0e290e4fe1fb60a476265f83402a9bb99509ff1e',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '9e50e0c77f9cfeceddb031f11d195918e291d77cd8bad06c9d113e91a9e04e67',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': 'bc7e125914c37b46cecfc88f8aad97044cac1ef7fde5bb18728d5d6ee7514957',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': 'ba00557e6b946a2654cc23b7114ff46d295a768d29cba47451a53b1ae7c74a5c',
                         '.agents/skills/merge-reviewer/VERSION': 'f6ee69bf1c4b27a242266ccb5aeb4aa8c8306345b9ebe4ff7335b8c940452b81',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/report-style.md': '6dd70a1b7db718c8ea00b98e973040bd43a888cc35556375057353985de7b628',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': '444de71670c44be03d7ea006c662e02953f467cada042cd5b26c24014bb31005',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '57cf497d8824152e6f4eedc1daa1e9253e4144452de2aedb4a79f31b4bf48b2c',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '45eb51ad64df0274fb5b600de14ab33cc2f5f1d2fa56c95f253845a92a007ad9',
                         '.agents/skills/release-reviewer/SKILL.md': '7904ca2d15956c080f4ebdcbc0b138bb7308c3d973a8970af4d106f4d1217235',
                         '.agents/skills/release-reviewer/VERSION': 'd915cc95d6ca8f47ae297713ed46d4e5c5d99ddd29fc3c61e263bdf305f2b5b0',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'ba6643e15ea33f6f827edc13276499bd9207f28ece1c74857b4695c0da57c78f',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '88c8593603299f65b5025ec72d97222f7151c7a1b25331e88dc3b478cc7fe0bf',
                                                                                                     'upstream_sha256': '6fb668d3b0e779bb50f2628cab7f7532d8f94ca57e0de01a7c7bcfa4810d1c7b'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                                                                                                                                'upstream_sha256': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                                                                                                                                    'upstream_sha256': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                                                                                                                                 'upstream_sha256': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4'}}}},
               'payloadSha256': '36f2c3b72096db7612196a7f6abee1a43dcf42c8406569f03ccd314c6636a110',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': '9eb969cc4c604fed1fdea51ed0140d65a71bb68ecd692312085a7f571381940e',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': '59106cc2eaf0e0ad2bfa444e77811768820b22a1a3b1e3c49d17aacb30232595'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '292c5172f225ddfca5f0212acac3ad33156759cecbb66b0594fb89c6f1080e9a',
                                              'version': '0.6.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '81c530799f72c661bfe56e1c04dedaeb0c4534d5f387363821f85c95ff137ed8',
                                      'version': '0.8.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.1.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'a36d743c059aef8542bce52ba2b96bc015fd1d9986ecf50a4fc4e4fba0edcce2',
                                               'version': '0.12.1'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a482db2395462c1848d9bdb9b60e7eee781d9bafbe646cad7c715c350c3618a4',
                                                 'version': '0.3.0'}},
               'version': '0.24.1',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '88c8593603299f65b5025ec72d97222f7151c7a1b25331e88dc3b478cc7fe0bf',
                             '.agents/skills/codebase-wiki/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '04f30fb161dbeb678dc1736514a887b527956a79da7abd16a210031faf6f0312',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce'},
              {'agentBlockSha256': '4f647de11777b57eaf48ceb9ec0e84380f11d2a8772b6ca80d298089b2fe1feb',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': 'f7a966dc8bde19695b1cd62c43bb76af8a1766d562e12ffe3d5c024359081eca',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '840755db509a4ae595f8d635caecae29149e96be80453f7395330ce3948dac22',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': '52fd528f6c3ebbe098e931a162ce7d8acf67f32f9b93d71699774ce5b0ffebec',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'cc7ad3f1a107bd6c2018e11a698f34b828b15cdc2b8840e1e2c7978bfb1e3688',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': '9ff25fc665305ebe051dc332a367acbe959e78e6a385d8ea890596dac9199946',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': '15f285f76670db7b36f6e9ca0321761e517251f4572382fbe9c8efb287969289',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '318891b8f013846d0c2665b380e5236fd4b21e94e21a95a1c04484ddf018f47b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4750f827629b7c9be87952d45d5ddcc31fd54ca35b1b5f76b211e733dc9c6733',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': '7e834f5521a9382a97250dc544e50c1bd074f5fff39c93ece362b70a2d401e0d',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': 'cd71e47d3787d0a9441968fb7583e13b65041c1e530998811863efdb362ea2dc',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd6c86d0f6df2612e958c938133a1c412811ce986de1dc31e536b2f2bf83abb5c',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': '85bc93921b8b09d64c6b11ab0e290e4fe1fb60a476265f83402a9bb99509ff1e',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '9e50e0c77f9cfeceddb031f11d195918e291d77cd8bad06c9d113e91a9e04e67',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': '523fb9453989cd804813c891322f199f2beb07c5ceedc8d3bcf9f7b319fdad5a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': 'bc7e125914c37b46cecfc88f8aad97044cac1ef7fde5bb18728d5d6ee7514957',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': 'ba00557e6b946a2654cc23b7114ff46d295a768d29cba47451a53b1ae7c74a5c',
                         '.agents/skills/merge-reviewer/VERSION': 'f6ee69bf1c4b27a242266ccb5aeb4aa8c8306345b9ebe4ff7335b8c940452b81',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/report-style.md': '6dd70a1b7db718c8ea00b98e973040bd43a888cc35556375057353985de7b628',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': '444de71670c44be03d7ea006c662e02953f467cada042cd5b26c24014bb31005',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '57cf497d8824152e6f4eedc1daa1e9253e4144452de2aedb4a79f31b4bf48b2c',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '45eb51ad64df0274fb5b600de14ab33cc2f5f1d2fa56c95f253845a92a007ad9',
                         '.agents/skills/release-reviewer/SKILL.md': '7904ca2d15956c080f4ebdcbc0b138bb7308c3d973a8970af4d106f4d1217235',
                         '.agents/skills/release-reviewer/VERSION': 'd915cc95d6ca8f47ae297713ed46d4e5c5d99ddd29fc3c61e263bdf305f2b5b0',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'ba6643e15ea33f6f827edc13276499bd9207f28ece1c74857b4695c0da57c78f',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {},
               'payloadSha256': '2b42fd9fb697bcef177db7d33b623951b547a72dd219cb1c2292122d4ba28468',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': 'e6364cff46e5acdc52dba09187678bc37255a078ac4dac18d0a71ce35a51d80d',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'cd4b5e6da74418172299af1f4a60c48cfc5f2dd59f9ee1228f70e50ff28d6311'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '292c5172f225ddfca5f0212acac3ad33156759cecbb66b0594fb89c6f1080e9a',
                                              'version': '0.6.0'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '81c530799f72c661bfe56e1c04dedaeb0c4534d5f387363821f85c95ff137ed8',
                                      'version': '0.8.0'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.1.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'a36d743c059aef8542bce52ba2b96bc015fd1d9986ecf50a4fc4e4fba0edcce2',
                                               'version': '0.12.1'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a482db2395462c1848d9bdb9b60e7eee781d9bafbe646cad7c715c350c3618a4',
                                                 'version': '0.3.0'}},
               'version': '0.24.1',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '6fb668d3b0e779bb50f2628cab7f7532d8f94ca57e0de01a7c7bcfa4810d1c7b',
                             '.agents/skills/codebase-wiki/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': 'f843ea17567d6aba8006e0ffbd48fdf7f7afc635e86c5b8604c251b897d92fc5',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '04f30fb161dbeb678dc1736514a887b527956a79da7abd16a210031faf6f0312',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce'},
              {'agentBlockSha256': '9b11ce6f74edeaa6ce5f70e0f5414b5583cb55459c23e2ae0684de0bbcc4b3cd',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': '1e5ed21281dc13b6a3b8b0b6b99442738729d8976d9b6ddf6c34df330c6ce02a',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '83778f2134bc540be1a0505f11bec6f5d527663afb85c001b213d27fa70de5c9',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': 'bfa82b975e331e1e28dbaefef62ac3f9c0a416c752d7c902bf2daae3a78a7c6f',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'ad42321cbb05ec5d720e61dd3166c25b230fdec2733b2b54540f82b019e68cdc',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': 'bedc013bf24fcd8db951aff275cf9179f2cd62f6fdaf92d204c4773c514c2734',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': 'ff52d3d5e848fc259efc90d8378a9c90fca86c01982d04ff3020a1a9ce14e297',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '6a7d414abca3b25ec86c1a170916efcc511e629294c3c127388bde89db39b73b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4d820660551d9155c1e8db5fb09b5adbca84ad90ed3f1198bdb44e14747370f5',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': 'fd265025b37de6b417c55c9f9e4ae656ac3a9d58abe48db4d71e121c5ef734d5',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': '1d19ba0ceff9379f4a8fbc0b34eeaa48dbf5b94f8d95f08ea7765ac23d7d7da3',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd4950321814c248dff9712137476d2022614cf82b5289810b89248f183167771',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': 'cfdb8ee72f5f3f4f0b1bf23cadba19edcc082b2e847a98fd33f719ff9171c5cf',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '24735a8231dc71802d8aca36dba09d49cfcfe5e19c70c96bf6357a44e888d922',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': 'aafd6a92c6673704f7844674ec6d78f269c2f36804994f60522e8d99c8db1a9a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': '33752ca83cdb8f002989e5f1a229047da0b4714a1d622bc13714872457ad2aa6',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-examples.md': '05bc5eeffda1b8cdbf8966f538066f98227b0eddb9ef7cbf0a59d9f78c38028f',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': 'bab2cabb9e287c4c069378a5b744f1e5ec13ce10a69562323e2d9d67210199e7',
                         '.agents/skills/merge-reviewer/VERSION': 'f482d06e4ee83158e42999dcf951d5909861dad7e03317deb2b1e2ddd5c46274',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'c10c3c01e296c197aae3f00362ab91795fd245aa4b3beface990626b31f7626e',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': 'a41f8e2ce070b3b475e7471c6651cbd0e575fffcf8e662b8f59cabf73fcbebc3',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '57cf497d8824152e6f4eedc1daa1e9253e4144452de2aedb4a79f31b4bf48b2c',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '45eb51ad64df0274fb5b600de14ab33cc2f5f1d2fa56c95f253845a92a007ad9',
                         '.agents/skills/release-reviewer/SKILL.md': '2693bfa0c1f57c0649d075021892128d5ae80328f17201b303046a8948e01d99',
                         '.agents/skills/release-reviewer/VERSION': '79e3f22ca37c7fdf4c29ae3648d6b008c3cb6547260a453409275470919dc674',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '65a59312abbb7c299c6b35407ee68dd6d5c56a89165f9ee9734a8bb95849725c',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'eef44d27107ce64931bc29eed20254f1d045a7c541177d6b01d565718c5405ab',
                                                                                                     'upstream_sha256': '80beb93b098162de66e896d00cf2bfb1b4e5688f51a75402cab19f75bd77331b'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                                                                                                                                'upstream_sha256': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                                                                                                                                    'upstream_sha256': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                                                                                                                                 'upstream_sha256': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4'}}}},
               'payloadSha256': '236f1b69d5e5ad330f9fb594144e7dd145c51f9eea0019e13014755a26b4e2b8',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': '9eb969cc4c604fed1fdea51ed0140d65a71bb68ecd692312085a7f571381940e',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': '59106cc2eaf0e0ad2bfa444e77811768820b22a1a3b1e3c49d17aacb30232595'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'd9b10390028d70a26b473737de582c4b2cf2286d019c03f3d0673f81602bf8ce',
                                              'version': '0.6.1'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '2cd73766cd19de5ad26d6437ee50d5c9f3a37f6e67b7193c440e5c3b8d303395',
                                      'version': '0.8.1'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.2.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '81f7ceebeb32dfe38b62acd0885ae380d5c693ad32f315f6a12f6278406a61fb',
                                               'version': '0.12.2'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '40b4b9eca3b8f8c08b0cecbda5c96dbd998d8bd4050b523135e8afdb36f9cfd5',
                                                 'version': '0.3.1'}},
               'version': '0.24.2',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'eef44d27107ce64931bc29eed20254f1d045a7c541177d6b01d565718c5405ab',
                             '.agents/skills/codebase-wiki/VERSION': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': '114651f7bbea36880b9530cdee8a73e8484928a400b840db0a10175f7d13b206',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': 'b45474b368f600af5ce2638b60785fd45369f48c24815903548904a669b10821',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033'},
              {'agentBlockSha256': '4f647de11777b57eaf48ceb9ec0e84380f11d2a8772b6ca80d298089b2fe1feb',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': '1e5ed21281dc13b6a3b8b0b6b99442738729d8976d9b6ddf6c34df330c6ce02a',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '83778f2134bc540be1a0505f11bec6f5d527663afb85c001b213d27fa70de5c9',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': 'bfa82b975e331e1e28dbaefef62ac3f9c0a416c752d7c902bf2daae3a78a7c6f',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'ad42321cbb05ec5d720e61dd3166c25b230fdec2733b2b54540f82b019e68cdc',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': 'bedc013bf24fcd8db951aff275cf9179f2cd62f6fdaf92d204c4773c514c2734',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': 'ff52d3d5e848fc259efc90d8378a9c90fca86c01982d04ff3020a1a9ce14e297',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '6a7d414abca3b25ec86c1a170916efcc511e629294c3c127388bde89db39b73b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4d820660551d9155c1e8db5fb09b5adbca84ad90ed3f1198bdb44e14747370f5',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': 'fd265025b37de6b417c55c9f9e4ae656ac3a9d58abe48db4d71e121c5ef734d5',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': '1d19ba0ceff9379f4a8fbc0b34eeaa48dbf5b94f8d95f08ea7765ac23d7d7da3',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd4950321814c248dff9712137476d2022614cf82b5289810b89248f183167771',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': 'cfdb8ee72f5f3f4f0b1bf23cadba19edcc082b2e847a98fd33f719ff9171c5cf',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '24735a8231dc71802d8aca36dba09d49cfcfe5e19c70c96bf6357a44e888d922',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': 'aafd6a92c6673704f7844674ec6d78f269c2f36804994f60522e8d99c8db1a9a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': '33752ca83cdb8f002989e5f1a229047da0b4714a1d622bc13714872457ad2aa6',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-examples.md': '05bc5eeffda1b8cdbf8966f538066f98227b0eddb9ef7cbf0a59d9f78c38028f',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': 'bab2cabb9e287c4c069378a5b744f1e5ec13ce10a69562323e2d9d67210199e7',
                         '.agents/skills/merge-reviewer/VERSION': 'f482d06e4ee83158e42999dcf951d5909861dad7e03317deb2b1e2ddd5c46274',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'c10c3c01e296c197aae3f00362ab91795fd245aa4b3beface990626b31f7626e',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': 'a41f8e2ce070b3b475e7471c6651cbd0e575fffcf8e662b8f59cabf73fcbebc3',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '57cf497d8824152e6f4eedc1daa1e9253e4144452de2aedb4a79f31b4bf48b2c',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '45eb51ad64df0274fb5b600de14ab33cc2f5f1d2fa56c95f253845a92a007ad9',
                         '.agents/skills/release-reviewer/SKILL.md': '2693bfa0c1f57c0649d075021892128d5ae80328f17201b303046a8948e01d99',
                         '.agents/skills/release-reviewer/VERSION': '79e3f22ca37c7fdf4c29ae3648d6b008c3cb6547260a453409275470919dc674',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '65a59312abbb7c299c6b35407ee68dd6d5c56a89165f9ee9734a8bb95849725c',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {},
               'payloadSha256': 'd7a4a6fabda31ef6b3423db0403fa7c5e444d49e376d2782d7e0ef92604bb045',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': 'e6364cff46e5acdc52dba09187678bc37255a078ac4dac18d0a71ce35a51d80d',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'cd4b5e6da74418172299af1f4a60c48cfc5f2dd59f9ee1228f70e50ff28d6311'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'd9b10390028d70a26b473737de582c4b2cf2286d019c03f3d0673f81602bf8ce',
                                              'version': '0.6.1'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '2cd73766cd19de5ad26d6437ee50d5c9f3a37f6e67b7193c440e5c3b8d303395',
                                      'version': '0.8.1'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.2.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '81f7ceebeb32dfe38b62acd0885ae380d5c693ad32f315f6a12f6278406a61fb',
                                               'version': '0.12.2'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '40b4b9eca3b8f8c08b0cecbda5c96dbd998d8bd4050b523135e8afdb36f9cfd5',
                                                 'version': '0.3.1'}},
               'version': '0.24.2',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '80beb93b098162de66e896d00cf2bfb1b4e5688f51a75402cab19f75bd77331b',
                             '.agents/skills/codebase-wiki/VERSION': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': '114651f7bbea36880b9530cdee8a73e8484928a400b840db0a10175f7d13b206',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': 'b45474b368f600af5ce2638b60785fd45369f48c24815903548904a669b10821',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033'},
              {'agentBlockSha256': '9b11ce6f74edeaa6ce5f70e0f5414b5583cb55459c23e2ae0684de0bbcc4b3cd',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': '1e5ed21281dc13b6a3b8b0b6b99442738729d8976d9b6ddf6c34df330c6ce02a',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '83778f2134bc540be1a0505f11bec6f5d527663afb85c001b213d27fa70de5c9',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': 'bfa82b975e331e1e28dbaefef62ac3f9c0a416c752d7c902bf2daae3a78a7c6f',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'ad42321cbb05ec5d720e61dd3166c25b230fdec2733b2b54540f82b019e68cdc',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': 'bedc013bf24fcd8db951aff275cf9179f2cd62f6fdaf92d204c4773c514c2734',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': 'ff52d3d5e848fc259efc90d8378a9c90fca86c01982d04ff3020a1a9ce14e297',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '6a7d414abca3b25ec86c1a170916efcc511e629294c3c127388bde89db39b73b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4d820660551d9155c1e8db5fb09b5adbca84ad90ed3f1198bdb44e14747370f5',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': 'fd265025b37de6b417c55c9f9e4ae656ac3a9d58abe48db4d71e121c5ef734d5',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': '1d19ba0ceff9379f4a8fbc0b34eeaa48dbf5b94f8d95f08ea7765ac23d7d7da3',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd4950321814c248dff9712137476d2022614cf82b5289810b89248f183167771',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': 'cfdb8ee72f5f3f4f0b1bf23cadba19edcc082b2e847a98fd33f719ff9171c5cf',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '24735a8231dc71802d8aca36dba09d49cfcfe5e19c70c96bf6357a44e888d922',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': 'aafd6a92c6673704f7844674ec6d78f269c2f36804994f60522e8d99c8db1a9a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': '33752ca83cdb8f002989e5f1a229047da0b4714a1d622bc13714872457ad2aa6',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-examples.md': '05bc5eeffda1b8cdbf8966f538066f98227b0eddb9ef7cbf0a59d9f78c38028f',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': 'bab2cabb9e287c4c069378a5b744f1e5ec13ce10a69562323e2d9d67210199e7',
                         '.agents/skills/merge-reviewer/VERSION': 'f482d06e4ee83158e42999dcf951d5909861dad7e03317deb2b1e2ddd5c46274',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'c10c3c01e296c197aae3f00362ab91795fd245aa4b3beface990626b31f7626e',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': 'a41f8e2ce070b3b475e7471c6651cbd0e575fffcf8e662b8f59cabf73fcbebc3',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '57cf497d8824152e6f4eedc1daa1e9253e4144452de2aedb4a79f31b4bf48b2c',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '45eb51ad64df0274fb5b600de14ab33cc2f5f1d2fa56c95f253845a92a007ad9',
                         '.agents/skills/release-reviewer/SKILL.md': '2693bfa0c1f57c0649d075021892128d5ae80328f17201b303046a8948e01d99',
                         '.agents/skills/release-reviewer/VERSION': '79e3f22ca37c7fdf4c29ae3648d6b008c3cb6547260a453409275470919dc674',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '65a59312abbb7c299c6b35407ee68dd6d5c56a89165f9ee9734a8bb95849725c',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {'codebase-wiki': {'added': {'.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa'},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': 'eef44d27107ce64931bc29eed20254f1d045a7c541177d6b01d565718c5405ab',
                                                                                                     'upstream_sha256': '80beb93b098162de66e896d00cf2bfb1b4e5688f51a75402cab19f75bd77331b'},
                                                           '.agents/skills/codebase-wiki/assets/development-spec-template.md': {'overlay_sha256': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                                                                                                                                'upstream_sha256': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97'},
                                                           '.agents/skills/codebase-wiki/references/development-spec-workflow.md': {'overlay_sha256': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                                                                                                                                    'upstream_sha256': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2'},
                                                           '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': {'overlay_sha256': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                                                                                                                                 'upstream_sha256': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4'}}}},
               'payloadSha256': '236f1b69d5e5ad330f9fb594144e7dd145c51f9eea0019e13014755a26b4e2b8',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': '9eb969cc4c604fed1fdea51ed0140d65a71bb68ecd692312085a7f571381940e',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': '59106cc2eaf0e0ad2bfa444e77811768820b22a1a3b1e3c49d17aacb30232595'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'd9b10390028d70a26b473737de582c4b2cf2286d019c03f3d0673f81602bf8ce',
                                              'version': '0.6.1'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '2cd73766cd19de5ad26d6437ee50d5c9f3a37f6e67b7193c440e5c3b8d303395',
                                      'version': '0.8.1'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.2.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '81f7ceebeb32dfe38b62acd0885ae380d5c693ad32f315f6a12f6278406a61fb',
                                               'version': '0.12.2'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '40b4b9eca3b8f8c08b0cecbda5c96dbd998d8bd4050b523135e8afdb36f9cfd5',
                                                 'version': '0.3.1'}},
               'version': '0.24.3',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'eef44d27107ce64931bc29eed20254f1d045a7c541177d6b01d565718c5405ab',
                             '.agents/skills/codebase-wiki/VERSION': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': 'deb3b8c98fc2f4bfdcc67067f94a11ad7e9f9b74bcddfd14fc02fc323cf42691',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': '114651f7bbea36880b9530cdee8a73e8484928a400b840db0a10175f7d13b206',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'cc729c875f73446cbe5c77f338c2470ffb73ac0107ac148e55d1508167afdfd1',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/group-development-workflow.md': 'c97d089dd48065122ce50e47afaba3b23e178d13194496395fcc2b0b6d2cbffa',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': 'b45474b368f600af5ce2638b60785fd45369f48c24815903548904a669b10821',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'b8b71ec541cb979bae3194d020ff723e18fb9e403ee659005cd3382500cfc95b',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033'},
              {'agentBlockSha256': '4f647de11777b57eaf48ceb9ec0e84380f11d2a8772b6ca80d298089b2fe1feb',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'megin-resume',
                                'megin-spec-export',
                                'megin-workflow',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {'.agents/gitlab-workspace-kit/references/megin-spec-export.md': '9a94310052f9053263ff302116fd432a508463e3fd35c817989f20648abf03c3',
                                  '.agents/gitlab-workspace-kit/scripts/export-megin-spec.py': 'fb55c1a519d90861c4cec3abecc2c8f7a9390614d38aa6748811187ebcccd67a'},
               'files': {'.agents/skills/megin-architecture-exploration/SKILL.md': '1e5ed21281dc13b6a3b8b0b6b99442738729d8976d9b6ddf6c34df330c6ce02a',
                         '.agents/skills/megin-architecture-exploration/agents/openai.yaml': '3be4ee2070a6cf8c0bb07da9a9ad5024d28bc29e1f41cd1827d425dc5fd43456',
                         '.agents/skills/megin-behavior-contract/SKILL.md': '83778f2134bc540be1a0505f11bec6f5d527663afb85c001b213d27fa70de5c9',
                         '.agents/skills/megin-behavior-contract/agents/openai.yaml': '6103fa3c15b682ae62c5d581a3eb684b2519c428dbe0f21ccd6d2aec039edb1c',
                         '.agents/skills/megin-bug-diagnosis/SKILL.md': 'bfa82b975e331e1e28dbaefef62ac3f9c0a416c752d7c902bf2daae3a78a7c6f',
                         '.agents/skills/megin-bug-diagnosis/agents/openai.yaml': 'b4a3b01a7a025706acd54731f50235f6ddf84b9dd3d35355343a569edeca090a',
                         '.agents/skills/megin-code-review/SKILL.md': 'ad42321cbb05ec5d720e61dd3166c25b230fdec2733b2b54540f82b019e68cdc',
                         '.agents/skills/megin-code-review/agents/openai.yaml': 'fbefd99553b372002eb6250f42482a14dcef69b724357a00365d72ec44ca99e4',
                         '.agents/skills/megin-finishing-delivery/SKILL.md': 'bedc013bf24fcd8db951aff275cf9179f2cd62f6fdaf92d204c4773c514c2734',
                         '.agents/skills/megin-finishing-delivery/agents/openai.yaml': 'c92a5852a5609b199b60e7af4e09cc8d7ccfe08fcdb7281d3f4e0d4fba67dc25',
                         '.agents/skills/megin-human-acceptance/SKILL.md': 'ff52d3d5e848fc259efc90d8378a9c90fca86c01982d04ff3020a1a9ce14e297',
                         '.agents/skills/megin-human-acceptance/agents/openai.yaml': 'be402ad137c4473157d26264944a551d6b6208df8465adcd71cf22b01923a3f8',
                         '.agents/skills/megin-implementation-execution/SKILL.md': '6a7d414abca3b25ec86c1a170916efcc511e629294c3c127388bde89db39b73b',
                         '.agents/skills/megin-implementation-execution/agents/openai.yaml': '737fade8892914a52e65ea111f4bbec6bd017ba1a800d80241cdf331da85e5bb',
                         '.agents/skills/megin-project-knowledge/SKILL.md': '4d820660551d9155c1e8db5fb09b5adbca84ad90ed3f1198bdb44e14747370f5',
                         '.agents/skills/megin-project-knowledge/agents/openai.yaml': 'ee6bf8501513e2cf0ea2cb20adf83d53431edea759d6d64ce557dd9b015b35f9',
                         '.agents/skills/megin-requirements-discovery/SKILL.md': 'fd265025b37de6b417c55c9f9e4ae656ac3a9d58abe48db4d71e121c5ef734d5',
                         '.agents/skills/megin-requirements-discovery/agents/openai.yaml': 'd8ae80eec56aa5ea2f52b3ae4635ef88cb6ff6e61d7b7819a82dc8ebc9bfc5d7',
                         '.agents/skills/megin-technical-planning/SKILL.md': '1d19ba0ceff9379f4a8fbc0b34eeaa48dbf5b94f8d95f08ea7765ac23d7d7da3',
                         '.agents/skills/megin-technical-planning/agents/openai.yaml': '82ca1d372af56c12fd1ed61a0f347e66ab0ece9a9d4a7a952b80a5cb4b4de3d8',
                         '.agents/skills/megin-test-driven-development/SKILL.md': 'd4950321814c248dff9712137476d2022614cf82b5289810b89248f183167771',
                         '.agents/skills/megin-test-driven-development/agents/openai.yaml': 'f5963232403b8253a806e569ec303a0589de4a324f79800091b30a0e6c5ef60e',
                         '.agents/skills/megin-verification-before-completion/SKILL.md': 'cfdb8ee72f5f3f4f0b1bf23cadba19edcc082b2e847a98fd33f719ff9171c5cf',
                         '.agents/skills/megin-verification-before-completion/agents/openai.yaml': '7f0962f7d3b7dafee3f62fa3175e7d63ef24e28d241e3267bd3b9ed34752cce6',
                         '.agents/skills/megin/SKILL.md': '24735a8231dc71802d8aca36dba09d49cfcfe5e19c70c96bf6357a44e888d922',
                         '.agents/skills/megin/agents/openai.yaml': '3d63b75ee2bb6a860fde1d9839bab613ce6b3dd80cbcb14b4f20882f5a6a9922',
                         '.agents/skills/megin/references/branch-policy.md': '5c8b85359c41eba08dbc7c768686127a4bae7042eedff43ca09e70099a1ae3e3',
                         '.agents/skills/megin/references/delivery-receipts.md': '331a789abd55e9c9c67838321ef07af9580dfc9353a5809ecfd6eb61ff6d3ae4',
                         '.agents/skills/megin/references/group-impact.md': '7a6f1116566bce0a41473a478793ab521ecb87770f477debdc5cdc0ed4e88784',
                         '.agents/skills/megin/references/language-policy.md': 'aafd6a92c6673704f7844674ec6d78f269c2f36804994f60522e8d99c8db1a9a',
                         '.agents/skills/megin/references/new-work-evidence.md': '35285fe0b6e8e147e962c7d0fee715b95e23ca17d5293a27e19b25ba4419d607',
                         '.agents/skills/megin/references/quality-gates.md': '7a6bddb6f7867c857d8ce19414e5b32e000968b0796de904996d14abdef4b44c',
                         '.agents/skills/megin/references/repository-workflow.md': '33752ca83cdb8f002989e5f1a229047da0b4714a1d622bc13714872457ad2aa6',
                         '.agents/skills/megin/references/requirements-discovery-protocol.md': 'eda57760e7b5851a0a98058871270d63eb32138f7bece911563532f45818ca4d',
                         '.agents/skills/megin/references/requirements-template.md': '9ef029ec196fc3ae536b823d073625b36b15893d0a6dc0bdb53c69a29fabc58f',
                         '.agents/skills/megin/references/verification-extensions.md': '7485377ef86743db414b55ecac5835f18b915a5b89de6d4ba84cb64d2a74ee38',
                         '.agents/skills/megin/references/workflow-examples.md': '05bc5eeffda1b8cdbf8966f538066f98227b0eddb9ef7cbf0a59d9f78c38028f',
                         '.agents/skills/megin/references/workflow-record.md': '01852d875b6ec0aec87acf6962aded508e71c701d6b65d0cbf0497a58fe99164',
                         '.agents/skills/megin/references/workspace-workflow.md': '3c45c43d7af1535f295464a5021ece3ed80b72009dd9ae6fb8477281de5fef6b',
                         '.agents/skills/megin/scripts/behavior_trace.py': '11f77eccb4620530e9027e76c192d276b80e7dd530eacb0a4d8fe5deafa0e35c',
                         '.agents/skills/megin/scripts/delivery_receipt.py': '04b93fe59e6c0d7f33c16c11ee1a74f7bcd2a17465160715758a41bbefb339c1',
                         '.agents/skills/megin/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                         '.agents/skills/megin/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                         '.agents/skills/megin/scripts/git_snapshot.py': 'c733001854f03615276af0174560ef136301b1877d968872747b7b798a0b982f',
                         '.agents/skills/megin/scripts/group_quality_gate.py': 'fa3c95f10983c0e92601e2732d2a22b21f6147346ccf422b5a61fc37964f5b94',
                         '.agents/skills/megin/scripts/impact_policy.py': 'e4207a767933ba1ad436fc24539ba0e51740eee5ad421edc24a029e6e7041aaa',
                         '.agents/skills/megin/scripts/install_skills.py': 'c699eb98480db9feb8b4d230dd79909f3e2e1d3156dd0b6a9da0eebb123c84b6',
                         '.agents/skills/megin/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                         '.agents/skills/megin/scripts/quality_gate.py': '78c4fe46944ff3fdd0ea32825dcb931ee6c3502fe09cf7a8cdf7fba27af64474',
                         '.agents/skills/megin/scripts/quality_policy.py': 'd244ee4d491347c4c14a4b21425fe2018da7d07d56bd9deea13c70970b509fde',
                         '.agents/skills/megin/scripts/repo_workspace.py': '71ad27cd324e8c96cfc9bfc5cec1a8f201933cc1aacf503c49e8dafaf2b08c4c',
                         '.agents/skills/megin/scripts/review_history.py': '53451423bb9433d95451e295f2d5ab69f57ce7b9f89cb483136b6efea1c801ca',
                         '.agents/skills/megin/scripts/source_baseline.py': 'fdc4acc25086b90eccc2978b836d52e4732ac4578e8649407b5a406f280f641e',
                         '.agents/skills/megin/scripts/unified_workflow.py': 'e5e5b8eefd1e30adeeec074f2017b806e796564b067cdbf4aea05d66e4f4700c',
                         '.agents/skills/megin/scripts/validate_skills.py': 'c978700eabe490c60289e5409c95a170c0e1db638ac00bb6a79d1133c6d515ae',
                         '.agents/skills/megin/scripts/verification_inputs.py': '9039a6ecf51c950253e0b7d7cb1c8948eb7367cacbb48816f2104e38e84a676b',
                         '.agents/skills/megin/scripts/workspace_context.py': '62d84e7cc82d1380e6472c64672e4582e707b5b44b5ecc9961b970688aef2e8b',
                         '.agents/skills/megin/scripts/workspace_extension.py': '40dd311d3d22bc069bcee051af609769ffa9a10d76f47efbf59687104c9ec506',
                         '.agents/skills/megin/scripts/workspace_lock.py': '2925147cd68e6d47b85c19c607db8a51b01cdde3fee20a3719f1d1b420266333',
                         '.agents/skills/merge-reviewer/SKILL.md': 'bab2cabb9e287c4c069378a5b744f1e5ec13ce10a69562323e2d9d67210199e7',
                         '.agents/skills/merge-reviewer/VERSION': 'f482d06e4ee83158e42999dcf951d5909861dad7e03317deb2b1e2ddd5c46274',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'c10c3c01e296c197aae3f00362ab91795fd245aa4b3beface990626b31f7626e',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'bb5317d0c26833c1de0695beb653c2e73e5f6552993b01ec1d5a3b4e644eb9eb',
                         '.agents/skills/merge-reviewer/references/usage.md': 'a41f8e2ce070b3b475e7471c6651cbd0e575fffcf8e662b8f59cabf73fcbebc3',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '57cf497d8824152e6f4eedc1daa1e9253e4144452de2aedb4a79f31b4bf48b2c',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e639f87f5c04230478cad2c133d69b84b7d726a9f462c4e7c68fde39baf7ad57',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '6d71c62e311065bb0973ec91a6dab7b952c045412fb252875c57fbda346878d3',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'ba8bd34e39e80bf5a86920be5788452ed3d703dec4f2bfb0b2cb442c4103be39',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '45eb51ad64df0274fb5b600de14ab33cc2f5f1d2fa56c95f253845a92a007ad9',
                         '.agents/skills/release-reviewer/SKILL.md': '2693bfa0c1f57c0649d075021892128d5ae80328f17201b303046a8948e01d99',
                         '.agents/skills/release-reviewer/VERSION': '79e3f22ca37c7fdf4c29ae3648d6b008c3cb6547260a453409275470919dc674',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '65a59312abbb7c299c6b35407ee68dd6d5c56a89165f9ee9734a8bb95849725c',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': '90e54a3b991caa3875f11e2c5eb4f1aafef32829aff50f0093c8fff1f29e8e74',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '660311412534137d147368a2dc095b8a0e93eba93cd534275cd35a2b1c4456ff',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '0b79f14834566f0fe221c287a84073ccf5bd43d65a800a2f3425d300e0f62429',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'bafd97dbd8f77064051eb79ba074324d4bbb7413ea1248a71e9f4f7eec1a006b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9f65a31f308256204cfbc4ff5111b1a33cc35205e12cf2dd7a4ee78ce6384cc7',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'cf91083ef54cb68c0d21e2c092d54b92ce200b11c1f8bae087d41afdff907043',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025'},
               'overlays': {},
               'payloadSha256': 'd7a4a6fabda31ef6b3423db0403fa7c5e444d49e376d2782d7e0ef92604bb045',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': 'e6364cff46e5acdc52dba09187678bc37255a078ac4dac18d0a71ce35a51d80d',
                                 'legacy-cleanup.md': '3e3392d67722b5ccdfc535e51e36e26c65c4c79724ffb76138f79889d05bf4d0',
                                 'profile.md': 'cd4b5e6da74418172299af1f4a60c48cfc5f2dd59f9ee1228f70e50ff28d6311'},
               'skills': ['codebase-wiki',
                          'megin',
                          'megin-architecture-exploration',
                          'megin-behavior-contract',
                          'megin-bug-diagnosis',
                          'megin-code-review',
                          'megin-finishing-delivery',
                          'megin-human-acceptance',
                          'megin-implementation-execution',
                          'megin-project-knowledge',
                          'megin-requirements-discovery',
                          'megin-technical-planning',
                          'megin-test-driven-development',
                          'megin-verification-before-completion',
                          'merge-reviewer',
                          'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'd9b10390028d70a26b473737de582c4b2cf2286d019c03f3d0673f81602bf8ce',
                                              'version': '0.6.1'},
                            'megin': {'asset': 'megin-skills.zip',
                                      'repository': 'Megin',
                                      'sha256': '2cd73766cd19de5ad26d6437ee50d5c9f3a37f6e67b7193c440e5c3b8d303395',
                                      'version': '0.8.1'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.12.2.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '81f7ceebeb32dfe38b62acd0885ae380d5c693ad32f315f6a12f6278406a61fb',
                                               'version': '0.12.2'},
                            'release-reviewer': {'asset': 'release-reviewer-0.3.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '40b4b9eca3b8f8c08b0cecbda5c96dbd998d8bd4050b523135e8afdb36f9cfd5',
                                                 'version': '0.3.1'}},
               'version': '0.24.3',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '80beb93b098162de66e896d00cf2bfb1b4e5688f51a75402cab19f75bd77331b',
                             '.agents/skills/codebase-wiki/VERSION': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033',
                             '.agents/skills/codebase-wiki/agents/openai.yaml': '9271764c5926e0b6bdbdb6dc3c85b993239457af0fd8afb1bf5d4eb5ff69f16f',
                             '.agents/skills/codebase-wiki/assets/adr-template.md': '997ef0b94714ec9f4f55eb76c5b8f90f1b8a662e12f6e0d003c1ed8bf7abac76',
                             '.agents/skills/codebase-wiki/assets/architecture-template.md': 'c7bd1fdc708579f1beb55f4e968a26c96f0ca25f774dec3631d154f037c674b9',
                             '.agents/skills/codebase-wiki/assets/business-analysis-template.md': '86a7963e946e959d630543b47e2bb82b559b2db9e50ae48f53494cf600f29327',
                             '.agents/skills/codebase-wiki/assets/business-glossary-template.md': 'f4b48fe6809653c37838769651564147e273435807b4184c031b1a84f2bcf693',
                             '.agents/skills/codebase-wiki/assets/business-knowledge-gaps-template.md': '19690d3be358579851c5e7008b515a6a4bcacfa63e9e811dc62a0b3c3ce97368',
                             '.agents/skills/codebase-wiki/assets/business-process-catalog-template.md': 'ea1a36e9e490dfddd250797b051ea7f0746c1a21c90f003e89855d1bfccbe3ba',
                             '.agents/skills/codebase-wiki/assets/business-process-template.md': '36b670867a795cbd90f36c3b29abbabb84b34605797d38947fc368bd7092dd22',
                             '.agents/skills/codebase-wiki/assets/business-requirement-template.md': '03ae424db04e0bac193a884e2a737b73c6c25190730738b104322bd88413cf2d',
                             '.agents/skills/codebase-wiki/assets/business-rule-catalog-template.md': 'c7ec238c806cb7611399ad61454e64c704d1281a44f49c4ddcd6f0db1c5fed71',
                             '.agents/skills/codebase-wiki/assets/business-rule-template.md': '45bacf4d50d664068cf69763e003e5a05c7a810112066cf4c63e3069bd986b5e',
                             '.agents/skills/codebase-wiki/assets/code-audit-template.md': '84c7ae5ff76b51f4d2e69840675ceb345dea300a2c48948fcd0e8755610b10bb',
                             '.agents/skills/codebase-wiki/assets/codebase-functional-coverage-template.md': '7dec8996286572c6605a3b64a46b731b0ca107bdfabf29658eb0ae85bf6d440f',
                             '.agents/skills/codebase-wiki/assets/dependency-template.md': 'a8a0938561f73b2d4c219078f19f3e073892f8ba037b5ac8ac54877e465fef6c',
                             '.agents/skills/codebase-wiki/assets/development-spec-template.md': '76a2ce016a7cdc852be23ac01c7c9152bdbfb30d1005f99dc0f6c8bfafd9ea97',
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '24537d815569007b82bb644368ae477ad385fda6dfd3a0e719b2c176c0169aa9',
                             '.agents/skills/codebase-wiki/assets/overview-template.md': '19026e4f1788c0faac0fabe2efc61b5ab29ae24cfcb55582fdd748c548f6f283',
                             '.agents/skills/codebase-wiki/assets/pattern-template.md': 'd67e94285fc7f12b2840194762358f8b105e9a1c3319a5624bcfbb619cfc9594',
                             '.agents/skills/codebase-wiki/assets/project-function-catalog-template.md': '9b392f4f631ef00a32adc68ab793efc10eb0d880aa056ab606bad0e755ed34c1',
                             '.agents/skills/codebase-wiki/assets/synthesis-template.md': '45bb257325b139ffe54f2094f13cd364dd5ee96a535434462b5a8d0b199aebbf',
                             '.agents/skills/codebase-wiki/assets/system-analysis-template.md': 'd833d3dc752c8cc06a97f090e68a1f29cb70ead6723e76a7a8bb9f2367e70d9b',
                             '.agents/skills/codebase-wiki/assets/system-design-template.md': '1df551536536936d95ba8e3bda0970d14461965c6cc9eb794cf4aac453fa34ac',
                             '.agents/skills/codebase-wiki/assets/target-agents-block.md': '114651f7bbea36880b9530cdee8a73e8484928a400b840db0a10175f7d13b206',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/architecture/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/decisions/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/dependencies/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/entities/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/guides/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/index.md': 'f633e6f22f579e73f7594852d31f8183973a399f8f30e353fb83d45b0c0233ef',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/log.md': '8f4d65c7c434ca6882fbe0a499cf16447b45adf7e343d8e0a91ccef964a9e4d4',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/modules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/overview.md': '75bb18d2cd3c907f52ce3659ddd8c453dceb3308d99641e178facef42faa146b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/patterns/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/processes/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/requirements/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/rules/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/assets/wiki-starter/synthesis/.gitkeep': '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
                             '.agents/skills/codebase-wiki/bin/tgrep-manifest.json': 'b7c3bcdf6cf6124ca5368082754a3b2c9dfc960cafc6975be3c57871a7706d89',
                             '.agents/skills/codebase-wiki/bin/windows-x64/tgrep.exe': '9b90e4446e2cbf05e1da086547501e35d7b32f0f6d5f687548cf270b07fbd9d7',
                             '.agents/skills/codebase-wiki/capabilities.json': 'f3b5d7a59459cb1f82d0ef74caa70e465abacd071306aaf2dd1acfbb10bf6df3',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/development-spec-workflow.md': 'dccf3f2ee8e1eaee1b58b2b0d3a963b9524aa123dededc3884d6db40e3eb24a2',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': '4c2c79ea98da658ce30d2f6d2430c130d59fd1de1c24c2abf7f53ede03b9de92',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': '0a63686f8ff9f3fb4c35b10c5e962a3d17050b321ccbb72857656a2ad0424675',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': 'b45474b368f600af5ce2638b60785fd45369f48c24815903548904a669b10821',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '938d67d251c20f1a0508aaaa102a2f02ea284bab9c48c73523bd674e7acdd5a8',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '4272d5c5f56139db019949e4e797ff7c71b3ac2509e03829455affdf87e05b04',
                             '.agents/skills/codebase-wiki/scripts/development_spec.py': '3b2464dac361979a3b795dcb331e9df10087b6dc3b5620aaa9a08ea669e9fcd0',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5cbc4b3197410ff68d089f640827ae8e7bcccf10bb78e7a43b0c2faadc6ca973',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '765780049a4954398c318b50e52464139ae72197b2d4c012919c49189774d0b8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': '5d0a3a672a5beed9e8cbf97299909cd6c1f82c9104f8217b46bb51b44f9b7a18',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': '4e0643bfcccd6ce26c7d4105ab832459fa345ccff21a74bfb4c4672c514cdd17',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '477dacb5c58271393811eb65ae8e577104a0264434ee87d4a367d3edd0107a4d',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': 'bfe4ba5f0df633302b7e7cb55572731aa49412b5ec7ab34062d3e0ac1d9432f7',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '7e4aa255996206704eec0470c216e865568d5545bc35d4539db253c0bc3bd972',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '363718eb175e8ab54f704546e69a83c5218737a4de0a22d491d5df9ec0931179',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-development-spec.py': 'fe477ab85bb842553dd1f39d325f486cd41dace3fb1dcb133024e8f004c338e4',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033'}],
 'schema': 'gitlab-workspace-kit-predecessors/v1'}
SPECIAL_RULES = {'analysisIssueFlow': 'draft-ready-scn-manual-issue',
 'developmentDelivery': 'native-megin-formal-workflow',
 'mergeRequestReview': 'branch-review-handoff-manual-comment',
 'releaseReview': 'entry-branches-group-chain-local-defaults-v3-single-workspace-report',
 'sourceReferences': 'Repo/path',
 'wikiFeedback': 'manual-after-all-local-repo-commits'}


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
        fail(f"安裝目錄無法讀取：{error}")
    if not root.is_dir():
        fail("請選擇有效的安裝資料夾。")
    return root


def stage_path(value: Path) -> Path:
    """Transactions can exceed MAX_PATH even when installed files do not."""
    text = str(value.absolute())
    if os.name == "nt" and not text.startswith("\\\\?\\"):
        return Path("\\\\?\\UNC\\" + text[2:] if text.startswith("\\\\") else "\\\\?\\" + text)
    return value


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
    if not isinstance(overlays, dict) or set(overlays) != set(OVERLAY_HASHES):
        fail("Declared overlay set is missing or invalid.")
    for overlay_id, overlay in overlays.items():
        overlay_digest = digest(json.dumps(overlay, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode("utf-8"))
        if overlay_digest != OVERLAY_HASHES[overlay_id]:
            fail(f"Pinned {overlay_id} overlay manifest digest does not match.")
    skill_names = manifest.get("skills")
    files = manifest.get("files")
    if not isinstance(skill_names, list) or skill_names != sorted(managed_skills()):
        fail("組合包 Skills 與固定來源不一致。")
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
    expected_outer = {manifest_path} | {name for name in entries if name.startswith(f"{ROOT}/payload/") or name.startswith(f"{ROOT}/framework/") or name.startswith(f"{ROOT}/sources/") or name.startswith(f"{ROOT}/repository-payload/")}
    if set(entries) != expected_outer:
        fail("組合包包含不允許的額外檔案。")
    framework = {name[len(f"{ROOT}/framework/"):]: content for name, content in entries.items() if name.startswith(f"{ROOT}/framework/")}
    original_wiki = _read_pinned_zip(sources[UPSTREAM["codebase-wiki"]["asset"]], UPSTREAM["codebase-wiki"])
    if framework != original_wiki:
        fail("Codebase LLM Wiki framework 內容與固定 Release ZIP 不一致。")
    _verify_upstream_payload(payload, original_wiki, sources, skill_names, overlays)
    if manifest.get("profiles") != PROFILE_MANIFESTS or manifest.get("capabilities") != PROFILE_MANIFESTS["group"]["capabilities"]:
        fail("Workflow profile metadata differs from this extension's reviewed profiles.")
    native = {name[len(f"{ROOT}/repository-payload/"):]: content for name, content in entries.items() if name.startswith(f"{ROOT}/repository-payload/")}
    profile = PROFILE_MANIFESTS["repository"]
    if {name: digest(content) for name, content in native.items()} != profile["files"]:
        fail("Native repository payload differs from its reviewed profile.")
    _verify_upstream_payload(native, original_wiki, sources, skill_names, {})
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
    for source_id in ("megin", "merge-reviewer", "release-reviewer"):
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
                    if not name.as_posix().startswith(source_id + "/"):
                        fail(f"{source_id} archive has an unexpected root.")
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
    extensions = {name: digest(content) for name, content in payload.items()
                  if name.startswith((".agents/gitlab-workspace-kit/scripts/", ".agents/gitlab-workspace-kit/references/"))}
    if extensions != KIT_EXTENSION_FILES:
        fail("Kit extensions differ from the pinned common resources.")
    if set(payload) != expected_profiles | actual_skill_paths | set(KIT_EXTENSION_FILES) or not expected_profiles.issubset(payload):
        fail("Payload contains undeclared files outside the Skills and workspace profile.")
    if skill_names != expected_skill_names or set(expected_skill_names) != managed_skills():
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


def trusted_package(raw: dict[str, Any]) -> dict[str, Any]:
    """Match provenance, profile and Skills against one frozen package version."""
    if (not isinstance(raw, dict) or not isinstance(raw.get("files"), dict)
            or any(not isinstance(p, str) for p in raw["files"])):
        fail("Installed package metadata is invalid.")
    upstream = {key: {k: v for k, v in value.items() if k != "root"} for key, value in UPSTREAM.items()}
    overlays = raw.get("overlays")
    if not isinstance(overlays, dict):
        fail("Installed overlay metadata is missing.")
    observed = {key: digest(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode("utf-8")) for key, value in overlays.items()}
    selected = None
    profile_name = raw.get("profile", "group")
    if profile_name not in ("group", "repository"):
        fail("Unknown installed workflow profile.")
    profile = PROFILE_MANIFESTS.get(profile_name, {})
    if (profile_name == "repository" and raw.get("version") == VERSION and raw.get("payloadSha256") == profile.get("payloadSha256")
            and raw.get("upstream") == upstream and overlays == {} and raw.get("local_update") is None):
        selected = {"files": {p: h for p, h in profile["files"].items() if p.startswith(".agents/skills/") and not p.startswith(".agents/skills/codebase-wiki/")},
                    "profileHashes": profile["profileHashes"], "skills": profile["skills"], "agentBlockSha256": profile["agentBlockSha256"]}
    elif (profile_name == "group" and raw.get("version") == VERSION and raw.get("payloadSha256") == CURRENT_PAYLOAD_SHA256
            and raw.get("upstream") == upstream and observed == OVERLAY_HASHES and raw.get("local_update") is None):
        selected = {"files": CURRENT_SKILL_FILES, "profileHashes": PROFILE_HASHES,
                    "skills": sorted(managed_skills()), "agentBlockSha256": AGENT_BLOCK_SHA256}
    elif profile_name in ("group", "repository"):
        for package in TRUSTED_PREDECESSORS["packages"]:
            if package.get("profile", "group") != profile_name:
                continue
            if all(raw.get(key) == package.get(key) for key in ("version", "payloadSha256", "upstream", "overlays")):
                selected = dict(package)
                update = raw.get("local_update")
                if update is not None:
                    selected = None
                    for reviewed in TRUSTED_PREDECESSORS["local_updates"]:
                        if (isinstance(update, dict) and update.get("schema") == "workflow-overlay-install/v1"
                                and update.get("upstream_payload_sha256") == package["payloadSha256"]
                                and all(update.get(key) == reviewed.get(key) for key in
                                        ("version", "payload_sha256", "files", "baseline_manifest_sha256"))):
                            selected = {**package, "files": {".agents/skills/" + p: h for p, h in reviewed["files"].items()}}
                            break
                break
    if selected is None:
        fail("Installed package is not a reviewed predecessor.")
    actual = {p: h for p, h in raw.get("files", {}).items()
              if p.startswith(".agents/skills/") and not p.startswith(".agents/skills/codebase-wiki/")}
    if actual != selected["files"]:
        fail("Installed Skill hashes differ from the reviewed package.")
    return selected


def trusted_skill_files(raw: dict[str, Any]) -> dict[str, str]:
    return trusted_package(raw)["files"]


WIKI_INSTALLED_VERSION_SHA256 = '87b241b275c591694846560e9879f50c9da3150f854efdabd782c539772f3033'


def verify_installed(root: Path, raw: dict[str, Any]) -> dict[str, Any]:
    if (not isinstance(raw, dict) or raw.get("schema") != "gitlab-workspace-kit-installed/v1" or raw.get("package") != PACKAGE
            or raw.get("workspaceContract") not in (1, WORKSPACE_CONTRACT)):
        fail("Group 組合包安裝紀錄契約無效。")
    if raw.get("workspaceContract") == WORKSPACE_CONTRACT:
        overlays = raw.get("overlays")
        if not isinstance(overlays, dict):
            fail("Installed overlay manifest is missing or invalid.")
        if not isinstance(raw.get("payloadSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", raw["payloadSha256"]):
            fail("Installed final payload digest is invalid.")
    trusted = trusted_package(raw)
    wiki_prefix = ".agents/skills/codebase-wiki/"
    # Reviewed same-version predecessors can have different Wiki bytes. Match
    # the provenance selected above instead of inferring identity from version.
    if "wikiFiles" in trusted or raw.get("version") != VERSION:
        wiki_expected = trusted.get("wikiFiles")
        if not isinstance(wiki_expected, dict) or not wiki_expected:
            fail("Reviewed predecessor Wiki fingerprints are missing.")
    else:
        wiki_expected = {p: h for p, h in PROFILE_MANIFESTS["repository"]["files"].items() if p.startswith(wiki_prefix)}
        if raw.get("profile", "group") == "group":
            wiki_expected[wiki_prefix + "VERSION"] = WIKI_INSTALLED_VERSION_SHA256
            overlay = raw["overlays"].get("codebase-wiki", {"added": {}, "replaced": {}})
            wiki_expected.update(overlay["added"])
            wiki_expected.update({p: value["overlay_sha256"] for p, value in overlay["replaced"].items()})
    wiki_actual = {p: h for p, h in raw["files"].items() if p.startswith(wiki_prefix) and p != wiki_prefix + "install-state.json"}
    if wiki_actual != wiki_expected:
        fail("Installed Wiki hashes differ from the verified profile.")
    expected_capabilities = installed_capabilities(raw)
    if raw.get("capabilities") is not None and raw["capabilities"] != expected_capabilities:
        fail("Installed capabilities differ from the verified profile.")
    for name, expected_hash in trusted["profileHashes"].items():
        if raw["files"].get(".agents/gitlab-workspace-kit/" + name) != expected_hash:
            fail("Installed Group profile differs from the reviewed package.")
    extension_expected = trusted.get("extensionFiles", KIT_EXTENSION_FILES if "wikiFiles" not in trusted else {})
    actual_extensions = {p: h for p, h in raw["files"].items()
                         if p.startswith((".agents/gitlab-workspace-kit/scripts/", ".agents/gitlab-workspace-kit/references/"))}
    if actual_extensions != extension_expected:
        fail("Installed kit extensions differ from the reviewed package.")
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
    if expected_skills != trusted["skills"]:
        fail("Group 組合包安裝記錄的 Skills 與受信任版本不一致。")
    if raw.get("agentBlockSha256") != trusted["agentBlockSha256"]:
        fail("Installed Group instructions differ from the reviewed package.")
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


def wiki_config_baseline(root: Path) -> dict[str, bytes | None]:
    result = {}
    for relative in WIKI_CONFIG_FILES:
        path = assert_safe(root, relative, allow_missing=True)
        result[relative] = read_regular(path, FILE_LIMIT) if path.exists() else None
    return result


def _toml_key_path(key: str) -> tuple[str, ...]:
    parsed = tomllib.loads(key + " = true")
    path = []
    while isinstance(parsed, dict) and len(parsed) == 1:
        name, parsed = next(iter(parsed.items()))
        path.append(name)
    if parsed is not True:
        raise ValueError("Invalid TOML assignment key.")
    return tuple(path)


def _toml_statements(text: str) -> list[tuple[int, int, tuple[str, ...], bool, str]]:
    """Locate complete TOML statements, respecting strings, comments and arrays."""
    spans = []
    start = index = depth = 0
    quote = ""
    comment = False
    while index < len(text):
        char = text[index]
        if comment:
            if char == "\n":
                comment = False
            else:
                index += 1
                continue
        elif quote:
            if quote.startswith('"') and char == "\\":
                index += 2
                continue
            if text.startswith(quote, index):
                index += len(quote)
                quote = ""
                continue
            index += 1
            continue
        elif char == "#":
            comment = True
        elif char in ('"', "'"):
            quote = char * 3 if text.startswith(char * 3, index) else char
            index += len(quote)
            continue
        elif char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
        if char == "\n" and depth == 0:
            spans.append((start, index + 1))
            start = index + 1
        index += 1
    if start < len(text):
        spans.append((start, len(text)))
    table = ()
    statements = []
    for start, end in spans:
        source = text[start:end].strip()
        if not source or source.startswith("#"):
            continue
        header = re.fullmatch(r"\[\[?(.+?)\]\]?\s*(?:#.*)?", source)
        if header:
            table = _toml_key_path(header[1])
            statements.append((start, end, table, True, ""))
            continue
        quote = ""
        for index, char in enumerate(source):
            if char in ('"', "'") and (index == 0 or source[index - 1] != "\\"):
                quote = "" if quote == char else char if not quote else quote
            elif char == "=" and not quote:
                key = source[:index].strip()
                statements.append((start, end, table + _toml_key_path(key), False, key))
                break
    return statements


def _toml_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(_toml_literal(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(json.dumps(key, ensure_ascii=False) + " = " + _toml_literal(item)
                                  for key, item in value.items()) + " }"
    raise ValueError("Unsupported TOML setting value.")


def _merge_wiki_toml(text: str, reference: dict[str, Any]) -> str:
    text = text.removeprefix("\ufeff")
    newline = "\r\n" if "\r\n" in text else "\n"
    for table, values in reference.items():
        for key, value in values.items():
            parsed = tomllib.loads(text)
            if table in parsed and not isinstance(parsed[table], dict):
                raise ValueError("Wiki TOML table conflicts with a project setting: " + table)
            if (isinstance(parsed.get(table), dict) and type(parsed[table].get(key)) is type(value)
                    and parsed[table].get(key) == value):
                continue
            target = (table, key)
            statements = _toml_statements(text)
            assignment = next((item for item in statements if not item[3] and target[:len(item[2])] == item[2]), None)
            if assignment:
                start, end, path, _, source_key = assignment
                replacement = value
                if path != target:
                    replacement = dict(parsed[table])
                    replacement[key] = value
                text = text[:start] + source_key + " = " + _toml_literal(replacement) + newline + text[end:]
            else:
                header = next((item for item in statements if item[3] and item[2] == (table,)), None)
                position = header[1] if header else 0
                source_key = json.dumps(key) if header else json.dumps(table) + "." + json.dumps(key)
                prefix = newline if position and not text[:position].endswith("\n") else ""
                text = text[:position] + prefix + source_key + " = " + _toml_literal(value) + newline + text[position:]
            actual = tomllib.loads(text).get(table, {}).get(key)
            if type(actual) is not type(value) or actual != value:
                raise ValueError("Wiki TOML merge did not produce the required setting.")
    return text


def _wiki_hooks(raw: bytes) -> dict[str, Any]:
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value, dict) or not isinstance(value.get("hooks", {}), dict):
        raise ValueError("Codex Hooks must be an object with an event map.")
    value.setdefault("hooks", {})
    if any(not isinstance(groups, list) or any(not isinstance(group, dict) for group in groups)
           for groups in value["hooks"].values()):
        raise ValueError("Codex Hook events must contain handler groups.")
    return value


def verify_wiki_config(relative: str, raw: bytes | None) -> bool:
    reference = WIKI_CONFIG_FILES.get(relative, "").encode("utf-8")
    if raw is None or not reference:
        return False
    try:
        if relative.endswith(".toml"):
            expected = tomllib.loads(reference.decode("utf-8"))
            actual = tomllib.loads(raw.decode("utf-8-sig"))
            return all(isinstance(actual.get(table), dict) and type(actual[table].get(key)) is type(value)
                       and actual[table].get(key) == value
                       for table, values in expected.items() for key, value in values.items())
        expected = _wiki_hooks(reference)["hooks"]
        actual = _wiki_hooks(raw)["hooks"]
        return all(actual.get(event, []).count(group) == 1 for event, groups in expected.items() for group in groups)
    except (UnicodeError, ValueError, TypeError, AttributeError):
        return False


def compose_wiki_config(baseline: dict[str, bytes | None], target: Path) -> None:
    """Apply Wiki-owned defaults while preserving unrelated project settings."""
    for relative, original in baseline.items():
        path = assert_safe(target, relative)
        reference = read_regular(path)
        if original is None or original == reference:
            continue
        if relative.endswith(".toml"):
            text = _merge_wiki_toml(original.decode("utf-8-sig"), tomllib.loads(reference.decode("utf-8")))
            path.write_bytes(text.encode("utf-8"))
        else:
            hooks = _wiki_hooks(original)
            for event, groups in _wiki_hooks(reference)["hooks"].items():
                current = hooks["hooks"].setdefault(event, [])
                for group in groups:
                    if group not in current:
                        current.append(group)
            path.write_bytes((json.dumps(hooks, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _verify_native_wiki_state(root: Path, path: Path) -> None:
    try:
        state = json.loads(read_regular(path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Codebase LLM Wiki 官方安裝記錄格式無效。")
    files = state.get("files") if isinstance(state, dict) else None
    if not isinstance(files, dict) or state.get("guard_mode") != "coexist" or state.get("surface") != "codex":
        fail("Codebase LLM Wiki 官方安裝記錄缺少 Codex coexist surface。")
    baseline = wiki_config_baseline(root)
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
            actual = digest(baseline[relative] or b"") if relative in baseline else digest(read_regular(target))
        if actual != record["sha256"].lower() and not (relative in baseline and
                verify_wiki_config(relative, baseline[relative])):
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
            if name in ("codebase-wiki", "merge-reviewer", "release-reviewer") or name.startswith("megin"):
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


def _workflow_roots(root: Path) -> list[Path]:
    """Only the declared root and its direct-child Git roots belong to this kit."""
    roots = [root]
    if not (root / ".git").exists():
        for child in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
            if child.is_dir() and not child.is_symlink() and (child / ".git").exists():
                assert_safe(root, child.name + "/.git")
                roots.append(child)
    return roots


def _git_common_dir(selected: Path) -> Path:
    probe = subprocess.run(["git", "-C", str(selected), "rev-parse", "--git-common-dir"],
                           capture_output=True, text=True, encoding="utf-8", timeout=10, check=False)
    if probe.returncode:
        fail(f"Cannot inspect Git common-dir before changing Skills: {selected}")
    common = Path(probe.stdout.strip())
    return checked_root(common if common.is_absolute() else selected / common)


def approved_work_in_progress(root: Path, ignored_locks=()) -> list[str]:
    blocked: list[str] = []
    for selected in _workflow_roots(root):
        label = "" if selected == root else selected.name + "/"
        blocked.extend(label + value for value in _root_work_in_progress(selected, ignored_locks))
        if not (selected / ".git").exists():
            continue
        common = _git_common_dir(selected)
        lock = assert_safe(common, "megin/workspace.lock.json", allow_missing=True)
        if lock.exists() and lock.resolve() not in ignored_locks:
            blocked.append(str(lock))
    return blocked


@contextlib.contextmanager
def maintenance_lock(root: Path, *, keep_on_error=False):
    """Share Megin's ownership paths so writers cannot race a kit replacement."""
    retained = recover_maintenance_locks(root)
    ignored = {Path(name).resolve() for name in retained['paths']} if retained else set()
    if approved_work_in_progress(root, ignored):
        fail("Finish or explicitly stop active Megin work before changing Skills.")
    paths = set()
    for selected in _workflow_roots(root):
        paths.add(assert_safe(selected, GROUP_LOCK, allow_missing=True))
        if (selected / '.git').exists():
            paths.add(assert_safe(_git_common_dir(selected), 'megin/workspace.lock.json', allow_missing=True))
    token = retained['token'] if retained else uuid.uuid4().hex
    raw = json.dumps({'schema': 'megin-workspace-owner/v2', 'root': str(root),
                      'work_id': 'kit-maintenance-' + token, 'writer': token,
                      'skills_sha256': 'maintenance'}, sort_keys=True).encode('utf-8')
    journal = assert_safe(root, '.gitlab-workspace/maintenance-locks.json', allow_missing=True)
    journal.parent.mkdir(exist_ok=True)
    _atomic_json(journal, {'schema': 'gitlab-workspace-kit-maintenance/v1', 'root': str(root),
                          'token': token, 'paths': sorted(str(path.resolve()) for path in paths)})
    owned = {path for path in ignored if path.exists()}
    succeeded = False
    try:
        for path in sorted(paths, key=lambda value: os.path.normcase(str(value))):
            path.parent.mkdir(parents=True, exist_ok=True)
            # Verify the parent after creation, before publishing an atomic owner.
            checked_root(path.parent)
            if path.resolve() in owned:
                if read_regular(path) != raw:
                    fail('Retained Megin maintenance ownership changed before recovery.')
                continue
            try:
                with path.open('xb') as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
            except FileExistsError:
                fail(f'Megin ownership was acquired during the upgrade: {path}')
            owned.add(path.resolve())
        if approved_work_in_progress(root, owned):
            fail('Megin work appeared during the upgrade preflight; keep its original package.')
        yield owned
        succeeded = True
    finally:
        if succeeded or not keep_on_error:
            for path in sorted(owned, key=str, reverse=True):
                if path.is_file() and not path.is_symlink() and path.read_bytes() == raw:
                    path.unlink()
            if journal.is_file() and not journal.is_symlink():
                value = json.loads(read_regular(journal).decode('utf-8'))
                if value.get('token') == token:
                    journal.unlink()


def recover_maintenance_locks(root: Path):
    """Validate dead kit ownership under its OS lock; keep it held through restore."""
    journal = assert_safe(root, '.gitlab-workspace/maintenance-locks.json', allow_missing=True)
    if not journal.exists():
        return
    value = json.loads(read_regular(journal).decode('utf-8'))
    token = value.get('token')
    if (value.get('schema') != 'gitlab-workspace-kit-maintenance/v1' or value.get('root') != str(root)
            or not isinstance(token, str) or not re.fullmatch('[0-9a-f]{32}', token)):
        fail('Invalid retained Megin maintenance ownership; preserve it for inspection.')
    allowed = set()
    for selected in _workflow_roots(root):
        allowed.add(str(assert_safe(selected, GROUP_LOCK, allow_missing=True).resolve()))
        if (selected / '.git').exists():
            allowed.add(str(assert_safe(_git_common_dir(selected), 'megin/workspace.lock.json', allow_missing=True).resolve()))
    paths = value.get('paths')
    if not isinstance(paths, list) or len(paths) != len(set(paths)) or not set(paths) <= allowed:
        fail('Retained maintenance lock paths differ from the declared workspace.')
    raw = json.dumps({'schema': 'megin-workspace-owner/v2', 'root': str(root),
                      'work_id': 'kit-maintenance-' + token, 'writer': token,
                      'skills_sha256': 'maintenance'}, sort_keys=True).encode('utf-8')
    for name in paths:
        path = Path(name)
        if path.exists():
            checked_root(path.parent)
            if path.is_symlink() or read_regular(path) != raw:
                fail('Retained Megin maintenance ownership changed; do not remove another writer lock.')
    return value


def _root_work_in_progress(root: Path, ignored_locks=()) -> list[str]:
    lock = assert_safe(root, GROUP_LOCK, allow_missing=True)
    if lock.exists() and lock.resolve() not in ignored_locks:
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
        status_match = re.search(r"^\s*(?:-\s*)?status:\s*[`'\"]?([a-z_-]+)[`'\"]?\s*$", text, re.MULTILINE | re.IGNORECASE)
        plan_match = re.search(r"^\s*(?:-\s*)?plan_version:\s*[`'\"]?([^\s`'\"]+)[`'\"]?\s*$", text, re.MULTILINE | re.IGNORECASE)
        status = status_match.group(1).casefold() if status_match else ""
        if status == "complete":
            continue
        if not plan_match:
            if (re.search(r"^\s*(?:-\s*)?schema:\s*[`'\"]?megin-", text, re.MULTILINE)
                    or status in {"active", "awaiting_user", "awaiting_review", "blocked", "needs_revision"}):
                blocked.append(f"docs/work/{directory.name}/workflow.md（{status}）")
            continue
        work_id = directory.name
        contract = assert_safe(root, directory.relative_to(root).as_posix() + "/" + safe_relative(plan_match.group(1)).as_posix() + "/quality-contract.json", allow_missing=True)
        if not contract.is_file() or contract.is_symlink():
            blocked.append(f"docs/work/{work_id}/workflow.md（已核准計畫）")
            continue
        try:
            value = json.loads(read_regular(contract).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            blocked.append(f"docs/work/{work_id}/workflow.md（計畫無法驗證）")
            continue
        if status != "complete" and isinstance(value, dict):
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
    baseline = wiki_config_baseline(root)
    for relative in ("Codex.md", ".codex/config.toml", ".codex/hooks.json"):
        current = assert_safe(root, relative, allow_missing=True)
        if current.exists():
            if relative in baseline:
                continue  # The coexistence layer merges these after native installation.
            else:
                _safe_copy_known(current, target / relative, stage)
    current_wiki_skill = assert_safe(root, ".agents/skills/codebase-wiki", allow_missing=True)
    if current_wiki_skill.exists():
        copy_safe_tree(current_wiki_skill, target / ".agents/skills/codebase-wiki")
        state_path = target / ".agents/skills/codebase-wiki/install-state.json"
        state = json.loads(read_regular(state_path).decode("utf-8"))
        for relative in baseline:
            state["files"].pop(relative, None)
        _atomic_json(state_path, state)
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
    compose_wiki_config(baseline, target)
    return applied, target


def _apply_wiki_overlay(candidate: Path, payload: dict[str, bytes], overlay: dict[str, Any], profile: str = "group") -> str:
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
    if profile == "repository":
        paths = {relative for relative in payload if relative.startswith(skill_prefix)}
        skill = candidate / ".agents/skills/codebase-wiki"
        for target in sorted(skill.rglob("*"), reverse=True):
            relative = target.relative_to(candidate).as_posix()
            if target.is_file() and relative not in paths and target.name != "install-state.json":
                target.unlink()
                state_files.pop(relative, None)
            elif target.is_dir() and not any(target.iterdir()):
                target.rmdir()
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
    journal["phase"] = "recovering"
    _atomic_json(stage / "transaction.json", journal)
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
            if target.exists() and new_digest and _action_hash(target) not in {new_digest, operation.get("expectedPreviousSha256")}:
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
            or journal.get("phase") not in ("prepared", "applying", "recovering")):
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
            if target.exists() and _action_hash(target) not in {operation.get("newSha256")}:
                fail("Pending transaction target changed; preserving all files.")
        elif operation["hadPrevious"]:
            if (not target.exists() or _action_hash(target) != operation.get("expectedPreviousSha256")
                    or (not incoming.exists() and journal.get("phase") != "recovering")):
                fail("Pending transaction original path changed or is missing.")
        elif target.exists() and (incoming.exists() or _action_hash(target) != operation.get("newSha256")):
            fail("Pending transaction new path changed; preserving all files.")
    if not (transaction_paths() - {"wiki"}).issubset(paths):
        fail("Pending transaction omits a bundle-managed path.")


def recover_incomplete(root: Path) -> None:
    if recover_maintenance_locks(root):
        with maintenance_lock(root, keep_on_error=True):
            return _recover_incomplete_locked(root, True)
    return _recover_incomplete_locked(root)


def _recover_incomplete_locked(root: Path, maintenance=False) -> None:
    stage_parent = assert_safe(root, ".gitlab-workspace/tool-installs", allow_missing=True)
    if not stage_parent.exists():
        return
    if not stage_parent.is_dir():
        fail("套件安裝暫存路徑不是資料夾。")
    for stage in sorted(stage_parent.iterdir(), key=lambda item: item.name):
        stage = stage_path(stage)
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
            if maintenance:
                _recover_transaction(root, stage, journal)
            else:
                with maintenance_lock(root, keep_on_error=True):
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
    _test_after_apply(0, len(operations))
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
           entry_root: str, archive_sha256: str, *, dry_run: bool = False, profile: str = "group") -> dict[str, Any]:
    root = checked_root(group_root)
    if profile not in ("group", "repository"):
        fail("Unknown workflow profile.")
    if profile == "repository":
        probe = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"], capture_output=True, text=True, encoding="utf-8", timeout=10, check=False)
        if probe.returncode or not Path(probe.stdout.strip()).samefile(root):
            fail("Native repository Skills require an actual Git repository root.")
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
        if not dry_run:
            resources.enter_context(maintenance_lock(root))
        wiki_path = assert_safe(root, "wiki", allow_missing=True)
        if wiki_path.exists() and not wiki_path.is_dir():
            fail("Group 的 wiki 路徑不是資料夾，無法安裝共用知識庫。")
        has_wiki = wiki_path.is_dir()
        stage = stage_path(stage_parent / f"kit-{uuid.uuid4().hex}")
        stage.mkdir()
        (stage / "owner.json").write_text(json.dumps({"package": PACKAGE, "group_root": str(root)}, ensure_ascii=False), encoding="utf-8")
        (stage / ".gitignore").write_bytes(b"*\n")
        journal_path = stage / "transaction.json"
        try:
            entries = extract_zip(archive) if archive_format == "zip" else extract_tar_xz(archive)
            manifest, payload = parse_manifest(entries, expected_version)
            profile_metadata = manifest["profiles"][profile]
            if profile == "repository":
                payload = {name[len(f"{ROOT}/repository-payload/"):]: content for name, content in entries.items() if name.startswith(f"{ROOT}/repository-payload/")}
                manifest = {**manifest, "files": profile_metadata["files"], "payloadSha256": profile_metadata["payloadSha256"], "overlays": {}}
            if (old_manifest and old_manifest.get("profile", "group") == profile and
                    old_manifest.get("version") == expected_version and old_manifest.get("payloadSha256") == manifest["payloadSha256"] and
                    old_manifest.get("source") == source and old_manifest.get("archiveSha256") == archive_sha256):
                shutil.rmtree(stage)
                return {"ok": True, "package": PACKAGE, "version": expected_version, "status": "unchanged",
                        "profile": profile, "source": source, "applied": False, "changed_paths": [], "skills": len(manifest["skills"]),
                        "upstreamVersions": {name: value["version"] for name, value in manifest["upstream"].items()},
                        "capabilities": profile_metadata["capabilities"]}
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
                candidate_payload, payload, manifest["overlays"].get("codebase-wiki", {"added": {}, "replaced": {}}), profile,
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
                fail("安裝暫存中的 Skills 與組合包 Manifest 不一致。")
            native_block = managed_block(rendered)
            expected_installed = {
                "schema": "gitlab-workspace-kit-installed/v1",
                "profile": profile,
                "installedRoot": str(root),
                "capabilities": profile_metadata["capabilities"],
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
                        "status": "ready" if changed else "unchanged", "applied": False, "profile": profile,
                        "upstreamVersions": {name: value["version"] for name, value in manifest["upstream"].items()},
                        "capabilities": profile_metadata["capabilities"],
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
                if child.name not in ("backups", "transaction.json", "owner.json", ".gitignore"):
                    _remove_owned(child)
            return {"ok": True, "package": PACKAGE, "version": expected_version, "source": source, "profile": profile,
                    "upstreamVersions": {name: value["version"] for name, value in manifest["upstream"].items()},
                    "capabilities": profile_metadata["capabilities"],
                    "skills": len(manifest["skills"]), "wiki": "preserved" if has_wiki else "seeded",
                    "status": "installed", "applied": True, "changed_paths": changed,
                    "transaction": ".gitlab-workspace/tool-installs/" + stage.name + "/transaction.json"}
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
    stage = stage_path(journal_path.parent)
    with KitInstallLock(assert_safe(root, INSTALL_LOCK, allow_missing=True)), maintenance_lock(root) as owned_locks:
        journal = json.loads(read_regular(journal_path).decode("utf-8"))
        owner = json.loads(read_regular(assert_safe(stage, "owner.json")).decode("utf-8"))
        if (owner != {"package": PACKAGE, "group_root": str(root)}
                or journal.get("schema") != "gitlab-workspace-kit-transaction/v1"
                or journal.get("group_root") != str(root) or journal.get("id") != stage.name
                or journal.get("phase") != "committed"
                or journal.get("payloadSha256") not in {profile["payloadSha256"] for profile in PROFILE_MANIFESTS.values()}):
            fail("Rollback transaction identity or reviewed payload differs.")
        if approved_work_in_progress(root, owned_locks):
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
        required = (transaction_paths() - {"wiki"})
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


def installed_capabilities(raw: dict[str, Any]) -> list[str]:
    profile = raw.get("profile", "group")
    if raw.get("version") == VERSION:
        return PROFILE_MANIFESTS[profile]["capabilities"]
    reviewed = next((p for p in TRUSTED_PREDECESSORS["packages"]
                     if p.get("version") == raw.get("version") and p.get("profile", "group") == profile), None)
    if reviewed and "capabilities" in reviewed:
        return list(reviewed["capabilities"])
    capabilities = [c for c in PROFILE_MANIFESTS[profile]["capabilities"] if c != "functional-exploration"]
    if "release-reviewer" not in raw.get("skills", []):
        capabilities.remove("release-review")
    return capabilities


def active_work_ids(root: Path, raw: dict[str, Any]) -> list[str]:
    if raw.get("installedRoot") is not None and Path(raw["installedRoot"]).resolve() != root:
        return []
    work_root = assert_safe(root, "docs/work", allow_missing=True)
    if not work_root.is_dir():
        return []
    result = []
    for directory in sorted(work_root.iterdir()):
        if not re.fullmatch(r"work-\d{8}-[a-z0-9-]+", directory.name) or not directory.is_dir() or directory.is_symlink():
            continue
        workflow = assert_safe(root, directory.relative_to(root).as_posix() + "/workflow.md", allow_missing=True)
        if not workflow.is_file():
            continue
        text = read_regular(workflow, 1024 * 1024).decode("utf-8")
        field = lambda name: re.search(r"^\s*(?:-\s*)?" + name + r":\s*[`\"']?([^\s`\"']+)", text, re.MULTILINE)
        status, plan = field("status"), field("plan_version")
        if not status or status[1] not in {"active", "awaiting_user", "awaiting_review", "blocked", "needs_revision"} or not plan:
            continue
        # An approved contract must exist in this exact Work ID, under the verified installation root.
        relative = directory.relative_to(root).as_posix() + "/" + safe_relative(plan[1]).as_posix() + "/quality-contract.json"
        contract = assert_safe(root, relative, allow_missing=True)
        if not contract.is_file():
            continue
        # These helpers are executed only after verify_installed has checked every managed
        # byte against a frozen release. Their read-only validators check the approved
        # contract, Work ID, root, plan version and the complete installed Skills fingerprint.
        code = """import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
root, work_id, profile = Path(sys.argv[2]), sys.argv[3], sys.argv[4]
import quality_gate
record_fields = quality_gate.workflow_fields(root / f'docs/work/{work_id}/workflow.md')
schema = record_fields.get('schema')
if (Path(sys.argv[1]) / 'unified_workflow.py').is_file() and schema in ('megin-skills-workflow/v6', 'megin-repo-workflow/v3'):
    import unified_workflow
    value = unified_workflow.validate_record(root, work_id, profile == 'group')
    value['plan_version'] = record_fields['plan_version']
elif profile == 'group':
    import group_quality_gate
    value = group_quality_gate.validate_record_group(root, work_id)
else:
    import repo_workspace
    fields, contract = repo_workspace.validate_plan(repo_workspace.validate_repo(root), work_id, 'resume')
    if contract.get('schema') not in ('megin-repo-quality-contract/v1', 'megin-repo-quality-contract/v2'):
        raise ValueError('Expected native repository contract')
    value = {'ok': True, 'work_id': fields['work_id'], 'plan_version': fields['plan_version']}
print(json.dumps(value))
"""
        try:
            validated = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", "-c", code,
                str(assert_safe(root, ".agents/skills/megin/scripts")), str(root), directory.name, raw.get("profile", "group")],
                capture_output=True, text=True, encoding="utf-8", timeout=15, check=False)
            value = json.loads(validated.stdout) if validated.returncode == 0 else {}
            if (value.get("ok"), value.get("work_id"), value.get("plan_version")) == (True, directory.name, plan[1]):
                result.append(directory.name)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            continue
    return result


def inspect_status(root_value: Path, expected_version: str) -> dict[str, Any]:
    root = checked_root(root_value)
    try:
        lock_path = assert_safe(root, INSTALL_LOCK, allow_missing=True)
        # A never-managed repository has no transaction to recover or metadata
        # to serialize. Reading its status must not dirty the Git working tree.
        state_paths = (lock_path, assert_safe(root, MARKER, allow_missing=True),
                       assert_safe(root, ".gitlab-workspace/tool-installs", allow_missing=True))
        if not any(path.exists() for path in state_paths):
            old = legacy_paths(root, include_installed=True)
            if old:
                return {"ok": True, "status": "needs-cleanup", "message": "請依組合包 cleanup 文件人工移除舊工具，保留 Wiki 與工作紀錄。", "legacyPaths": old[:24]}
            return {"ok": True, "status": "missing"}
        with KitInstallLock(lock_path):
            recover_incomplete(root)
            raw = _preflight_existing_workflow(root)
            if raw:
                active = approved_work_in_progress(root)
                profile = raw.get("profile", "group")
                metadata = {"version": raw["version"], "source": raw["source"], "profile": profile,
                            "upstreamVersions": {name: item["version"] for name, item in raw["upstream"].items()},
                            "capabilities": installed_capabilities(raw), "activeWorkIds": active_work_ids(root, raw)}
                if active:
                    return {"ok": True, "status": "work-in-progress", **metadata, "message": "請先完成原本的 Megin 工作再更新流程包。"}
                status = "installed" if (raw["version"] == expected_version and
                    raw.get("payloadSha256") == PROFILE_MANIFESTS[profile]["payloadSha256"] and
                    raw.get("local_update") is None) else "update-available"
                return {"ok": True, "status": status, **metadata}
            old = legacy_paths(root, include_installed=True)
            if old:
                return {"ok": True, "status": "needs-cleanup", "message": "請依組合包 cleanup 文件人工移除舊工具，保留 Wiki 與工作紀錄。", "legacyPaths": old[:24]}
            return {"ok": True, "status": "missing"}
    except (KitError, OSError, ValueError, TypeError, KeyError) as error:
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
    install_parser.add_argument("--profile", choices=("group", "repository"), default="group")
    install_parser.add_argument("--dry-run", action="store_true", help="Validate and preview in system temp without changing the Group.")
    rollback_parser = subcommands.add_parser("rollback")
    rollback_parser.add_argument("group_root", type=Path)
    rollback_parser.add_argument("journal", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "inspect":
            manifest, payload = import_package(args.archive, args.format, args.expected_version)
            print(json.dumps({"ok": True, "package": PACKAGE, "version": manifest["version"],
                              "profiles": {name: {"capabilities": value["capabilities"], "skills": value["skills"]} for name, value in manifest["profiles"].items()},
                              "upstreamVersions": {name: value["version"] for name, value in manifest["upstream"].items()},
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
                         args.entry_root, args.archive_sha256, dry_run=args.dry_run, profile=args.profile)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (KitError, OSError, ValueError, EOFError, subprocess.SubprocessError, tarfile.TarError,
            lzma.LZMAError, zipfile.BadZipFile, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error) or "組合包安裝已安全停止。"}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
