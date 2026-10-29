from __future__ import annotations

import argparse
import contextlib
import csv
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
VERSION = '1.0.0'
KIT_EXTENSION_FILES = {}
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


PROFILE_MANIFESTS = {'group': {'agentBlockSha256': 'b03d76dc4cc2c42dc9cd881098d782d537188d9f860a5cb6ab48f07f297ad8cf',
           'capabilities': ['adr',
                            'archaeology',
                            'audit',
                            'business-analysis',
                            'functional-exploration',
                            'ingest',
                            'lint',
                            'merge-repo',
                            'notebooklm-export',
                            'query',
                            'release-review',
                            'synthesis',
                            'system-analysis',
                            'system-design'],
           'files': {'.agents/gitlab-workspace-kit/group-instructions.md': '1f744c41872cf78cf3a4091a18c33a1861af39cd93b3e91b112800592f96064b',
                     '.agents/gitlab-workspace-kit/legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                     '.agents/gitlab-workspace-kit/profile.md': 'db5734e5cf5eaffbc6894d241e6cc4f687b84b577db95cbceefc4c4324b0ca88',
                     '.agents/skills/codebase-wiki/SKILL.md': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                     '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                     '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                     '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                     '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                     '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                     '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                     '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                     '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                     '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                     '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                     '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                     '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                     '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                     '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                     '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                     '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                     '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                     '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                     '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                     '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                     '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                     '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                     '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                     '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                     '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                     '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                     '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                     '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                     '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                     '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                     '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                     '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                     '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                     '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                     '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                     '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                     '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                     '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                     '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                     '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                     '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                     '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                     '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                     '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                     '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                     '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                     '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                     '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                     '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                     '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                     '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                     '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                     '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                     '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                     '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                     '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                     '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                     '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                     '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                     '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                     '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                     '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d',
                     '.agents/skills/merge-reviewer/SKILL.md': '36adab3bca4d9b30fbeab7510e68b024dc7976777dd6937d2166c64055cdd0ea',
                     '.agents/skills/merge-reviewer/VERSION': '06c53dd4f22b2e0038ca2bb9af32cc1ab7e69898d99cc3bfa22bd965f21aac8f',
                     '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                     '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                     '.agents/skills/merge-reviewer/references/contract-boundaries.md': 'dac84f58c6305cf6825f6595e028e0af60feef9b9d95061b00b1b5877bb21529',
                     '.agents/skills/merge-reviewer/references/report-style.md': '21bd5e766a972d18f76a5f64c20bb5e48ec830760b94a50d55109ff6d21e17ff',
                     '.agents/skills/merge-reviewer/references/review-rules.md': 'db76edd3e4d070480b49df4abcca2ce2ea35d2a2a6e30954e80ce3d2f0f99f6c',
                     '.agents/skills/merge-reviewer/references/runtime-controls.md': '325d133901aa928ba720763a8c0cf9628ddcb64084204bb3a67a53a33c4c8221',
                     '.agents/skills/merge-reviewer/references/session-workflow.md': 'd514812c8b8bb5b409e0891f7393d0d9ccfc406c1737f23121d03d1512780adc',
                     '.agents/skills/merge-reviewer/references/usage.md': '026347de479db94587dd5c12608a72efba74a0e5fca91508806e1129801e4818',
                     '.agents/skills/merge-reviewer/references/workspace-review.md': 'ff995f1e64a16534ff28637a8215d76ee1e13870be7b33e11219a8838a1b0ef6',
                     '.agents/skills/merge-reviewer/scripts/contract_boundary.py': 'f864aceb8dc75fbc1fc58d7926f9c208adf5dcad11899dfb3339d4c7682ca0d1',
                     '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '1555269f41f711d443b8d107b960824c4836c140624bc461470d07f7a05fda1b',
                     '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e448c5c8010131498559d8c646f6e6fc67a4c7d1ee773b578d8b2e7552118679',
                     '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                     '.agents/skills/merge-reviewer/scripts/report_receipt.py': 'd81e17396e5586071081f942a09ad08b16c2c6a8cdacb4735f3986f19b5d953e',
                     '.agents/skills/merge-reviewer/scripts/review_coordinator.py': '223ea0c90f41aa3c922768a987e26e47b38a0b66f276b176cd101959727015cf',
                     '.agents/skills/merge-reviewer/scripts/review_diagnostics.py': '5314c74dd38fe50d144c0be4f1adfe9e34da173b8654923726bbfbba0d58cad6',
                     '.agents/skills/merge-reviewer/scripts/review_flow.py': '9a84ba6429f38fb75e8dcfb8c1b12d5a034192084057590db74d4eecd6ef45af',
                     '.agents/skills/merge-reviewer/scripts/review_report.py': 'e3b13b89514216b6957b2d825b472a8b976fd7f5b1e392dc1a99fb63504e5da1',
                     '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'a39c46efa69c7a1803460782b5b94392b1e0ccc985afef2434b086f1f907d30c',
                     '.agents/skills/merge-reviewer/scripts/review_session.py': 'baf3b999af6e6a71893761768000345d2f7d450731d64614f44a1556079197e8',
                     '.agents/skills/merge-reviewer/scripts/review_workspace.py': '267ed29e90f284deeb2282393f10e9b97e48244b4df47155791a3d69fe39fabc',
                     '.agents/skills/merge-reviewer/scripts/workspace_report.py': '2e58bea4fae685e5d3bc7e0cd848568ccfa6edfb844e792112dda7ac721a85f1',
                     '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                     '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                     '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                     '.agents/skills/release-reviewer/SKILL.md': '75c9c7bd8b88bb2deabc30b0f2e471fac5fde1462efb64f582d9080a6debe64f',
                     '.agents/skills/release-reviewer/VERSION': 'a66780da23103beaf12432b418508966b31a2a3a787f9468a5b6cdaa8667c1ef',
                     '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                     '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                     '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                     '.agents/skills/release-reviewer/references/report-style.md': 'ff3d8c097a8f4d10cad7646156728c9e0adea1ef4aa86075cc63c457181d651a',
                     '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                     '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                     '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                     '.agents/skills/release-reviewer/references/runtime-controls.md': 'b4b74ff5ce210e3638f5f74970641500f29ef8efc72ead8269fc422c7f7f8953',
                     '.agents/skills/release-reviewer/references/session-workflow.md': '5bd96300ab6fa806101b534c4f5c2e97b20b785e16882f148206ceda7d040e07',
                     '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                     '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                     '.agents/skills/release-reviewer/scripts/evidence.py': '5fe9366fa52bfd17c17477001674f0575c732d4dc5a03a94a0e0e2ddc92dc34d',
                     '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '8dae6dcdfdbe0570808ea1d9463d9ec226595c5fb6b655738eb4141e4db1ae8a',
                     '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                     '.agents/skills/release-reviewer/scripts/git_review_context.py': '5efbd08f682adf22b0d9712e51d384fd86faabc5dca9f4a59f59c6aa9efda973',
                     '.agents/skills/release-reviewer/scripts/git_support.py': '9732c261fdcb476a965753730421a73029b72c4fc6cb5b6e70bcf33a010acd5a',
                     '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                     '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                     '.agents/skills/release-reviewer/scripts/release_report.py': '63e487a689d002cc3185f63095b9f31c786d55d6237591695299b5fdb64da3c4',
                     '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                     '.agents/skills/release-reviewer/scripts/review_coordinator.py': '6ed42471507e2e2c3591576d565f67ac3ef65092f85e3b5bf00272c6c6d15edc',
                     '.agents/skills/release-reviewer/scripts/review_flow.py': 'd461fa14bc17f6bd1184b65d2290b1d9d5259510963876e215ba94efb450ce8f',
                     '.agents/skills/release-reviewer/scripts/review_runtime.py': '71957e980353e8a7d8fefdeb61e35c2f4349c309bc6d194d5aefbea47419e8d7',
                     '.agents/skills/release-reviewer/scripts/review_session.py': 'fa93f1327c658df7d354104d9e504665ac0b8a2594533b9f19d289aa4e9d4f6a',
                     '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
           'overlays': {'codebase-wiki': {'added': {},
                                          'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                                                                                                 'upstream_sha256': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a'}}}},
           'payloadSha256': 'a02dbf62399d34af2828c4caef94ad59fa2a0ad53795cd4670302d078ff805d0',
           'profileHashes': {'group-instructions.md': '1f744c41872cf78cf3a4091a18c33a1861af39cd93b3e91b112800592f96064b',
                             'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                             'profile.md': 'db5734e5cf5eaffbc6894d241e6cc4f687b84b577db95cbceefc4c4324b0ca88'},
           'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer']},
 'repository': {'agentBlockSha256': 'fc63afed6c0c02f320f84a92faf15cff58d934531812c9d303e1d1b31f8815f3',
                'capabilities': ['adr',
                                 'archaeology',
                                 'audit',
                                 'business-analysis',
                                 'functional-exploration',
                                 'ingest',
                                 'lint',
                                 'merge-repo',
                                 'notebooklm-export',
                                 'query',
                                 'release-review',
                                 'synthesis',
                                 'system-analysis',
                                 'system-design'],
                'files': {'.agents/gitlab-workspace-kit/group-instructions.md': '250823e9f060e6a51abfbe45aea06ca4819770f91def7a6bed6d1bfd7e94c9ae',
                          '.agents/gitlab-workspace-kit/legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                          '.agents/gitlab-workspace-kit/profile.md': '6f53af6020c9135783509589b82339bec313d43bf6fa91a54973180bee4868bf',
                          '.agents/skills/codebase-wiki/SKILL.md': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a',
                          '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                          '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                          '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                          '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                          '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                          '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                          '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                          '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                          '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                          '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                          '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                          '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                          '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                          '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                          '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                          '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                          '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                          '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                          '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                          '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                          '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                          '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                          '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                          '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                          '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                          '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                          '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                          '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                          '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                          '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                          '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                          '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                          '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                          '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                          '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                          '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                          '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                          '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                          '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                          '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                          '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                          '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                          '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                          '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                          '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                          '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                          '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                          '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                          '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                          '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                          '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                          '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                          '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                          '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                          '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                          '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                          '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                          '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                          '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                          '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                          '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                          '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d',
                          '.agents/skills/merge-reviewer/SKILL.md': '36adab3bca4d9b30fbeab7510e68b024dc7976777dd6937d2166c64055cdd0ea',
                          '.agents/skills/merge-reviewer/VERSION': '06c53dd4f22b2e0038ca2bb9af32cc1ab7e69898d99cc3bfa22bd965f21aac8f',
                          '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                          '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                          '.agents/skills/merge-reviewer/references/contract-boundaries.md': 'dac84f58c6305cf6825f6595e028e0af60feef9b9d95061b00b1b5877bb21529',
                          '.agents/skills/merge-reviewer/references/report-style.md': '21bd5e766a972d18f76a5f64c20bb5e48ec830760b94a50d55109ff6d21e17ff',
                          '.agents/skills/merge-reviewer/references/review-rules.md': 'db76edd3e4d070480b49df4abcca2ce2ea35d2a2a6e30954e80ce3d2f0f99f6c',
                          '.agents/skills/merge-reviewer/references/runtime-controls.md': '325d133901aa928ba720763a8c0cf9628ddcb64084204bb3a67a53a33c4c8221',
                          '.agents/skills/merge-reviewer/references/session-workflow.md': 'd514812c8b8bb5b409e0891f7393d0d9ccfc406c1737f23121d03d1512780adc',
                          '.agents/skills/merge-reviewer/references/usage.md': '026347de479db94587dd5c12608a72efba74a0e5fca91508806e1129801e4818',
                          '.agents/skills/merge-reviewer/references/workspace-review.md': 'ff995f1e64a16534ff28637a8215d76ee1e13870be7b33e11219a8838a1b0ef6',
                          '.agents/skills/merge-reviewer/scripts/contract_boundary.py': 'f864aceb8dc75fbc1fc58d7926f9c208adf5dcad11899dfb3339d4c7682ca0d1',
                          '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '1555269f41f711d443b8d107b960824c4836c140624bc461470d07f7a05fda1b',
                          '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e448c5c8010131498559d8c646f6e6fc67a4c7d1ee773b578d8b2e7552118679',
                          '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                          '.agents/skills/merge-reviewer/scripts/report_receipt.py': 'd81e17396e5586071081f942a09ad08b16c2c6a8cdacb4735f3986f19b5d953e',
                          '.agents/skills/merge-reviewer/scripts/review_coordinator.py': '223ea0c90f41aa3c922768a987e26e47b38a0b66f276b176cd101959727015cf',
                          '.agents/skills/merge-reviewer/scripts/review_diagnostics.py': '5314c74dd38fe50d144c0be4f1adfe9e34da173b8654923726bbfbba0d58cad6',
                          '.agents/skills/merge-reviewer/scripts/review_flow.py': '9a84ba6429f38fb75e8dcfb8c1b12d5a034192084057590db74d4eecd6ef45af',
                          '.agents/skills/merge-reviewer/scripts/review_report.py': 'e3b13b89514216b6957b2d825b472a8b976fd7f5b1e392dc1a99fb63504e5da1',
                          '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'a39c46efa69c7a1803460782b5b94392b1e0ccc985afef2434b086f1f907d30c',
                          '.agents/skills/merge-reviewer/scripts/review_session.py': 'baf3b999af6e6a71893761768000345d2f7d450731d64614f44a1556079197e8',
                          '.agents/skills/merge-reviewer/scripts/review_workspace.py': '267ed29e90f284deeb2282393f10e9b97e48244b4df47155791a3d69fe39fabc',
                          '.agents/skills/merge-reviewer/scripts/workspace_report.py': '2e58bea4fae685e5d3bc7e0cd848568ccfa6edfb844e792112dda7ac721a85f1',
                          '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                          '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                          '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                          '.agents/skills/release-reviewer/SKILL.md': '75c9c7bd8b88bb2deabc30b0f2e471fac5fde1462efb64f582d9080a6debe64f',
                          '.agents/skills/release-reviewer/VERSION': 'a66780da23103beaf12432b418508966b31a2a3a787f9468a5b6cdaa8667c1ef',
                          '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                          '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                          '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                          '.agents/skills/release-reviewer/references/report-style.md': 'ff3d8c097a8f4d10cad7646156728c9e0adea1ef4aa86075cc63c457181d651a',
                          '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                          '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                          '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                          '.agents/skills/release-reviewer/references/runtime-controls.md': 'b4b74ff5ce210e3638f5f74970641500f29ef8efc72ead8269fc422c7f7f8953',
                          '.agents/skills/release-reviewer/references/session-workflow.md': '5bd96300ab6fa806101b534c4f5c2e97b20b785e16882f148206ceda7d040e07',
                          '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                          '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                          '.agents/skills/release-reviewer/scripts/evidence.py': '5fe9366fa52bfd17c17477001674f0575c732d4dc5a03a94a0e0e2ddc92dc34d',
                          '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '8dae6dcdfdbe0570808ea1d9463d9ec226595c5fb6b655738eb4141e4db1ae8a',
                          '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                          '.agents/skills/release-reviewer/scripts/git_review_context.py': '5efbd08f682adf22b0d9712e51d384fd86faabc5dca9f4a59f59c6aa9efda973',
                          '.agents/skills/release-reviewer/scripts/git_support.py': '9732c261fdcb476a965753730421a73029b72c4fc6cb5b6e70bcf33a010acd5a',
                          '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                          '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                          '.agents/skills/release-reviewer/scripts/release_report.py': '63e487a689d002cc3185f63095b9f31c786d55d6237591695299b5fdb64da3c4',
                          '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                          '.agents/skills/release-reviewer/scripts/review_coordinator.py': '6ed42471507e2e2c3591576d565f67ac3ef65092f85e3b5bf00272c6c6d15edc',
                          '.agents/skills/release-reviewer/scripts/review_flow.py': 'd461fa14bc17f6bd1184b65d2290b1d9d5259510963876e215ba94efb450ce8f',
                          '.agents/skills/release-reviewer/scripts/review_runtime.py': '71957e980353e8a7d8fefdeb61e35c2f4349c309bc6d194d5aefbea47419e8d7',
                          '.agents/skills/release-reviewer/scripts/review_session.py': 'fa93f1327c658df7d354104d9e504665ac0b8a2594533b9f19d289aa4e9d4f6a',
                          '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
                'overlays': {},
                'payloadSha256': '66d0a66b37916f1b8e7c1631e574ec4dbe957f776f80a108126213dc8502eec5',
                'profileHashes': {'group-instructions.md': '250823e9f060e6a51abfbe45aea06ca4819770f91def7a6bed6d1bfd7e94c9ae',
                                  'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                  'profile.md': '6f53af6020c9135783509589b82339bec313d43bf6fa91a54973180bee4868bf'},
                'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer']}}
WORKSPACE_CONTRACT = 2
ARCHIVE_LIMIT = 80 * 1024 * 1024
EXPANDED_LIMIT = 400 * 1024 * 1024
FILE_LIMIT = 64 * 1024 * 1024
COUNT_LIMIT = 12_000
ROOT = "workflow-kit"
MARKER = ".gitlab-workspace/tool-manifests/workflow-kit.json"
INSTALL_LOCK = ".workflow-kit-install.lock"
BEGIN = "<!-- gitlab-workspace-kit:managed:start -->"
END = "<!-- gitlab-workspace-kit:managed:end -->"
WIKI_BEGIN = "<!-- codebase-wiki:managed:start -->"
WIKI_END = "<!-- codebase-wiki:managed:end -->"
LEGACY_MARKERS = ('.gitlab-workspace/tool-manifests/codebase-wiki.json', '.gitlab-workspace/tool-manifests/merge-reviewer.json')
UPSTREAM = {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                   'repository': 'code-base-llm-wiki',
                   'root': 'codebase-llm-wiki-codex-0.6.4',
                   'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                   'version': '0.6.4'},
 'merge-reviewer': {'asset': 'merge-reviewer-0.19.0.zip',
                    'repository': 'MergeReviewer',
                    'root': '',
                    'sha256': '74fcd02ff44b7d3c6e7a7cbe50bcc17f17ff63a8ca3d6c922de53d2ab6d3c32e',
                    'version': '0.19.0'},
 'release-reviewer': {'asset': 'release-reviewer-0.8.0.zip',
                      'repository': 'ReleaseReviewer',
                      'root': '',
                      'sha256': 'b6ba140cd12db38fbe0ff2a43c142515197826b69891785f16e34e5012294a72',
                      'version': '0.8.0'}}
PROFILE_HASHES = {'group-instructions.md': '1f744c41872cf78cf3a4091a18c33a1861af39cd93b3e91b112800592f96064b',
 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
 'profile.md': 'db5734e5cf5eaffbc6894d241e6cc4f687b84b577db95cbceefc4c4324b0ca88'}
SOURCE_SUMMARY = ['Native Codebase LLM Wiki 0.6.4 is single-codebase; GitlabWorkSpace overlay restores Group-relative '
 'specifications and shared-Wiki rules.',
 'Native MergeReviewer 0.19.0 accepts one Repo and explicit base/head branches. Its own '
 'start/step/check/finish/status/cancel facade keeps MergeReviewSession/v1 jobs. The Skill agent applies '
 'Code Review defect criteria to the diff and evidence-linked consumers after start freezes base/head and '
 "all peer Repos' current local HEADs. It writes one Traditional Chinese report beginning with the "
 "conclusion and following the native five-section layout under the selected Repo's review-reports/ with "
 '8-character commit IDs in the filename and full evidence validation. No Workspace overlay or MR-specific '
 'report adapter is applied.',
 'Native ReleaseReviewer 0.8.0 accepts one Repo and explicit base/head branches. Its own '
 'start/step/check/finish/status/cancel facade keeps ReleaseReviewSession/v1 jobs in an independent runtime. '
 'The Skill agent reviews diff-linked blockers and deployment dependencies using base/head and all peer '
 "Repos' current local HEADs frozen by start. It writes one Traditional Chinese report beginning with the "
 'conclusion and following the native five-section layout with an editable manual checklist under the '
 "selected Repo's review-reports/ without an overlay."]
AGENT_BLOCK_SHA256 = 'b03d76dc4cc2c42dc9cd881098d782d537188d9f860a5cb6ab48f07f297ad8cf'
OVERLAY_HASHES = {'codebase-wiki': 'd506c19f42fd54b31d77f2e9175b46a00c62ad04166d03d734e8a25708bf0c27'}
CURRENT_PAYLOAD_SHA256 = 'a02dbf62399d34af2828c4caef94ad59fa2a0ad53795cd4670302d078ff805d0'
CURRENT_SKILL_FILES = {'.agents/skills/merge-reviewer/SKILL.md': '36adab3bca4d9b30fbeab7510e68b024dc7976777dd6937d2166c64055cdd0ea',
 '.agents/skills/merge-reviewer/VERSION': '06c53dd4f22b2e0038ca2bb9af32cc1ab7e69898d99cc3bfa22bd965f21aac8f',
 '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
 '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
 '.agents/skills/merge-reviewer/references/contract-boundaries.md': 'dac84f58c6305cf6825f6595e028e0af60feef9b9d95061b00b1b5877bb21529',
 '.agents/skills/merge-reviewer/references/report-style.md': '21bd5e766a972d18f76a5f64c20bb5e48ec830760b94a50d55109ff6d21e17ff',
 '.agents/skills/merge-reviewer/references/review-rules.md': 'db76edd3e4d070480b49df4abcca2ce2ea35d2a2a6e30954e80ce3d2f0f99f6c',
 '.agents/skills/merge-reviewer/references/runtime-controls.md': '325d133901aa928ba720763a8c0cf9628ddcb64084204bb3a67a53a33c4c8221',
 '.agents/skills/merge-reviewer/references/session-workflow.md': 'd514812c8b8bb5b409e0891f7393d0d9ccfc406c1737f23121d03d1512780adc',
 '.agents/skills/merge-reviewer/references/usage.md': '026347de479db94587dd5c12608a72efba74a0e5fca91508806e1129801e4818',
 '.agents/skills/merge-reviewer/references/workspace-review.md': 'ff995f1e64a16534ff28637a8215d76ee1e13870be7b33e11219a8838a1b0ef6',
 '.agents/skills/merge-reviewer/scripts/contract_boundary.py': 'f864aceb8dc75fbc1fc58d7926f9c208adf5dcad11899dfb3339d4c7682ca0d1',
 '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '1555269f41f711d443b8d107b960824c4836c140624bc461470d07f7a05fda1b',
 '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e448c5c8010131498559d8c646f6e6fc67a4c7d1ee773b578d8b2e7552118679',
 '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
 '.agents/skills/merge-reviewer/scripts/report_receipt.py': 'd81e17396e5586071081f942a09ad08b16c2c6a8cdacb4735f3986f19b5d953e',
 '.agents/skills/merge-reviewer/scripts/review_coordinator.py': '223ea0c90f41aa3c922768a987e26e47b38a0b66f276b176cd101959727015cf',
 '.agents/skills/merge-reviewer/scripts/review_diagnostics.py': '5314c74dd38fe50d144c0be4f1adfe9e34da173b8654923726bbfbba0d58cad6',
 '.agents/skills/merge-reviewer/scripts/review_flow.py': '9a84ba6429f38fb75e8dcfb8c1b12d5a034192084057590db74d4eecd6ef45af',
 '.agents/skills/merge-reviewer/scripts/review_report.py': 'e3b13b89514216b6957b2d825b472a8b976fd7f5b1e392dc1a99fb63504e5da1',
 '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'a39c46efa69c7a1803460782b5b94392b1e0ccc985afef2434b086f1f907d30c',
 '.agents/skills/merge-reviewer/scripts/review_session.py': 'baf3b999af6e6a71893761768000345d2f7d450731d64614f44a1556079197e8',
 '.agents/skills/merge-reviewer/scripts/review_workspace.py': '267ed29e90f284deeb2282393f10e9b97e48244b4df47155791a3d69fe39fabc',
 '.agents/skills/merge-reviewer/scripts/workspace_report.py': '2e58bea4fae685e5d3bc7e0cd848568ccfa6edfb844e792112dda7ac721a85f1',
 '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
 '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
 '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
 '.agents/skills/release-reviewer/SKILL.md': '75c9c7bd8b88bb2deabc30b0f2e471fac5fde1462efb64f582d9080a6debe64f',
 '.agents/skills/release-reviewer/VERSION': 'a66780da23103beaf12432b418508966b31a2a3a787f9468a5b6cdaa8667c1ef',
 '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
 '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
 '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
 '.agents/skills/release-reviewer/references/report-style.md': 'ff3d8c097a8f4d10cad7646156728c9e0adea1ef4aa86075cc63c457181d651a',
 '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
 '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
 '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
 '.agents/skills/release-reviewer/references/runtime-controls.md': 'b4b74ff5ce210e3638f5f74970641500f29ef8efc72ead8269fc422c7f7f8953',
 '.agents/skills/release-reviewer/references/session-workflow.md': '5bd96300ab6fa806101b534c4f5c2e97b20b785e16882f148206ceda7d040e07',
 '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
 '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
 '.agents/skills/release-reviewer/scripts/evidence.py': '5fe9366fa52bfd17c17477001674f0575c732d4dc5a03a94a0e0e2ddc92dc34d',
 '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '8dae6dcdfdbe0570808ea1d9463d9ec226595c5fb6b655738eb4141e4db1ae8a',
 '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
 '.agents/skills/release-reviewer/scripts/git_review_context.py': '5efbd08f682adf22b0d9712e51d384fd86faabc5dca9f4a59f59c6aa9efda973',
 '.agents/skills/release-reviewer/scripts/git_support.py': '9732c261fdcb476a965753730421a73029b72c4fc6cb5b6e70bcf33a010acd5a',
 '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
 '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
 '.agents/skills/release-reviewer/scripts/release_report.py': '63e487a689d002cc3185f63095b9f31c786d55d6237591695299b5fdb64da3c4',
 '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
 '.agents/skills/release-reviewer/scripts/review_coordinator.py': '6ed42471507e2e2c3591576d565f67ac3ef65092f85e3b5bf00272c6c6d15edc',
 '.agents/skills/release-reviewer/scripts/review_flow.py': 'd461fa14bc17f6bd1184b65d2290b1d9d5259510963876e215ba94efb450ce8f',
 '.agents/skills/release-reviewer/scripts/review_runtime.py': '71957e980353e8a7d8fefdeb61e35c2f4349c309bc6d194d5aefbea47419e8d7',
 '.agents/skills/release-reviewer/scripts/review_session.py': 'fa93f1327c658df7d354104d9e504665ac0b8a2594533b9f19d289aa4e9d4f6a',
 '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'}
TRUSTED_PREDECESSORS = {'local_updates': [],
 'packages': [{'agentBlockSha256': '3506a7690081c45d52ad47238435b1b6e3769e28b649084fa335ed56c5f0789e',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '053160628d0ebafb6232ee157fa5b997f4e7a0fcc57b350a5ba751f453971fd8',
                         '.agents/skills/merge-reviewer/VERSION': '065582655aacd6fc83ff742a5715c04bb4a57395bf3ee4559798fa42c2ce4589',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'ae227e5e75073a0026b71673035d78c353864bd2e7ca02cb70274ecec50b3fd6',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '9f73cf2e4612cc5bea51e91e4e32dfb9cd857c532ffaa01d85a9aa026fa3741d',
                         '.agents/skills/merge-reviewer/references/usage.md': 'f2d216cca6bf11e70629166ef59b8967633429716720c7decffa356c85d4107b',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'f89ff4cf4d9d037f57f17af850061fcb30d7a804a995473f1f3669a6f9a9d92a',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'fa23f7f1ef90f218435894075e7fdf5a5c332341911ea917d19b2c05c2394a47',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'c117d7fd6f5dba50da998da576775d2c72e19324cf15c46a5f426f2fcf0dfc76',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'ba48f6f210b5157c2a59e6d949365764c665c0d2438d80803acb8d60b3ee56ec',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '3c2e323ecf4d3b8274974b18ad82a33e2c25fac227697c66fd0470aabde65c46',
                         '.agents/skills/release-reviewer/VERSION': 'f62184cee8787f2f6941c82041a5725d4edc9aa293ebe5dbf664406e82ec1fe1',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': 'ba14f8c8eb4c2d89a909d69cacd9a058a18ed2f6a6b3e0b4067d47587c7926c3',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '355d5b2d780d84bb941db7dc24274750a4989ed450f7ca9fa3403d322a0ed723',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '044dcf261c85c3f733b5674c12b8859158abe0dd7b89f8d9c5603cebc1953bc2',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'aec585e105a0446d485ee1a0153ef1a8ed37455106b726053a96b5c6a11019f6',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
                                                                                                     'upstream_sha256': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4'}}}},
               'payloadSha256': '007c71025196679a24420bf884eb227e501511cca0e480feee3c01664c3588b7',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': '1ab448d82178766c454ec52ce866501abf0f018d1dd5fe785a7f8bfa23b72a95',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': 'd5138b22a9f7015999d29d0a23ea3200a805e3eeaf93da9378c86b12a5b10fe3'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '611b9727d723dec1d231654693b098f1b4454a20c893d3fd6f88f6f7b0d65aab',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.14.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '12896a08c49ce5c4aeacf0354fa125084b03bc7ee564156c660a671badf11cd3',
                                               'version': '0.14.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.4.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '3ffc3bada0bd961cc5a7681e0e7ffd6743abfb6d3032198561caba2d5bdd7f39',
                                                 'version': '0.4.1'}},
               'version': '0.25.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '437c4cd490ec22c52bc8145e67c1ef2d33590efd68a42d7a478f3792858ac2a8',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '053160628d0ebafb6232ee157fa5b997f4e7a0fcc57b350a5ba751f453971fd8',
                         '.agents/skills/merge-reviewer/VERSION': '065582655aacd6fc83ff742a5715c04bb4a57395bf3ee4559798fa42c2ce4589',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'ae227e5e75073a0026b71673035d78c353864bd2e7ca02cb70274ecec50b3fd6',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '9f73cf2e4612cc5bea51e91e4e32dfb9cd857c532ffaa01d85a9aa026fa3741d',
                         '.agents/skills/merge-reviewer/references/usage.md': 'f2d216cca6bf11e70629166ef59b8967633429716720c7decffa356c85d4107b',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'f89ff4cf4d9d037f57f17af850061fcb30d7a804a995473f1f3669a6f9a9d92a',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'fa23f7f1ef90f218435894075e7fdf5a5c332341911ea917d19b2c05c2394a47',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'c117d7fd6f5dba50da998da576775d2c72e19324cf15c46a5f426f2fcf0dfc76',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'ba48f6f210b5157c2a59e6d949365764c665c0d2438d80803acb8d60b3ee56ec',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '3c2e323ecf4d3b8274974b18ad82a33e2c25fac227697c66fd0470aabde65c46',
                         '.agents/skills/release-reviewer/VERSION': 'f62184cee8787f2f6941c82041a5725d4edc9aa293ebe5dbf664406e82ec1fe1',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': 'ba14f8c8eb4c2d89a909d69cacd9a058a18ed2f6a6b3e0b4067d47587c7926c3',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '355d5b2d780d84bb941db7dc24274750a4989ed450f7ca9fa3403d322a0ed723',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '044dcf261c85c3f733b5674c12b8859158abe0dd7b89f8d9c5603cebc1953bc2',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'aec585e105a0446d485ee1a0153ef1a8ed37455106b726053a96b5c6a11019f6',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
               'overlays': {},
               'payloadSha256': '912196959b2387f12a02cd20b67b571446b6e4c70d35a9ef8dca5181c24f484c',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': 'aa4b23404349a6724f85278c97bb67b8421d0ef293d330ceff1b1450f4021fa4',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '4312b9c3e153c4edf91ea3d67d76dc99fa068fd09d50cc4846d94d485560b892'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '611b9727d723dec1d231654693b098f1b4454a20c893d3fd6f88f6f7b0d65aab',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.14.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '12896a08c49ce5c4aeacf0354fa125084b03bc7ee564156c660a671badf11cd3',
                                               'version': '0.14.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.4.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '3ffc3bada0bd961cc5a7681e0e7ffd6743abfb6d3032198561caba2d5bdd7f39',
                                                 'version': '0.4.1'}},
               'version': '0.25.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '4da94770ca8742b754d58d8247cdac18622d498c913d66f7a37ce940aafe3c24',
               'bmadConfigTemplate': '# ─────────────────────────────────────────────────────────────────\n'
                                     '# Installer-managed. Regenerated on every install — treat as read-only.\n'
                                     '#\n'
                                     '# Direct edits to this file will be overwritten on the next install.\n'
                                     '# To change an install answer durably, re-run the installer (your prior\n'
                                     '# answers are remembered as defaults). To pin a value regardless of\n'
                                     '# install answers, or to add custom agents / override descriptors, use:\n'
                                     '#   _bmad/custom/config.toml       (team, committed)\n'
                                     '#   _bmad/custom/config.user.toml  (personal, gitignored)\n'
                                     '# Those files are never touched by the installer.\n'
                                     '# ─────────────────────────────────────────────────────────────────\n'
                                     '\n'
                                     '[core]\n'
                                     'user_name = "BMad"\n'
                                     'communication_language = "Traditional Chinese"\n'
                                     'project_name = "BMAD"\n'
                                     'document_output_language = "Traditional Chinese"\n'
                                     'output_folder = "_bmad-output"\n'
                                     '\n'
                                     '[modules.bmm]\n'
                                     'user_skill_level = "intermediate"\n'
                                     'planning_artifacts = "{project-root}/_bmad-output/planning-artifacts"\n'
                                     'implementation_artifacts = '
                                     '"{project-root}/_bmad-output/implementation-artifacts"\n'
                                     'project_knowledge = "{project-root}/docs"\n'
                                     '\n'
                                     '[agents.bmad-agent-analyst]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Mary"\n'
                                     'title = "Business Analyst"\n'
                                     'icon = "📊"\n'
                                     'description = "Channels Porter\'s strategic rigor and Minto\'s Pyramid '
                                     'Principle, grounds every finding in verifiable evidence, represents '
                                     'every stakeholder voice. Speaks like a treasure hunter narrating the '
                                     'find: thrilled by every clue, precise once the pattern emerges."\n'
                                     '\n'
                                     '[agents.bmad-agent-pm]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "John"\n'
                                     'title = "Product Manager"\n'
                                     'icon = "📋"\n'
                                     'description = "Drives Jobs-to-be-Done over template filling, user value '
                                     'first, technical feasibility is a constraint not the driver. Speaks like '
                                     'a detective interrogating a cold case: short questions, sharper '
                                     'follow-ups, every \'why?\' tightening the net."\n'
                                     '\n'
                                     '[agents.bmad-agent-ux-designer]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Sally"\n'
                                     'title = "UX Designer"\n'
                                     'icon = "🎨"\n'
                                     'description = "Balances empathy with edge-case rigor, starts simple and '
                                     'evolves through feedback, every decision serves a genuine user need. '
                                     'Speaks like a filmmaker pitching the scene before the code exists, '
                                     'painting user stories that make you feel the problem."\n'
                                     '\n'
                                     '[agents.bmad-agent-architect]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Winston"\n'
                                     'title = "System Architect"\n'
                                     'icon = "🏗️"\n'
                                     'description = "Favors boring technology for stability, developer '
                                     'productivity as architecture, ties every decision to business value. '
                                     'Speaks like a seasoned engineer at the whiteboard: measured, always '
                                     'laying out trade-offs rather than verdicts."\n'
                                     '\n'
                                     '[agents.bmad-agent-dev]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Amelia"\n'
                                     'title = "Senior Software Engineer"\n'
                                     'icon = "💻"\n'
                                     'description = "Test-first discipline (red, green, refactor), 100% pass '
                                     'before review, no fluff all precision. Speaks like a terminal prompt: '
                                     'exact file paths, AC IDs, and commit-message brevity — every statement '
                                     'citable."\n',
               'bmadFiles': {'_bmad/LICENSE': '0aa79baf6328b4a1e694ce10a12ffc36d7666554da128dff0e8fcda0fc536a66',
                             '_bmad/_config/bmad-help.csv': 'fc9c206d394e72d18a051b0de6eb18e2f1b3abae8f585927496cbf8f7a8ac365',
                             '_bmad/_config/files-manifest.csv': 'a3e609486256b49b4a5f9f3cb24f5545d63ea01ecbd3028bb40a2db75af35d9b',
                             '_bmad/_config/manifest.yaml': 'f35203ac12ca0e15e2c4e3a865bd58d91c142df0730b2f698c58db7f157a24c8',
                             '_bmad/_config/skill-manifest.csv': '6d414dcda3fbfc4c8716ab309dbfa5493c0ce0fee8566cc822918e5c874a2544',
                             '_bmad/bmm/config.yaml': '5c336426099f8fbc17eb406e0a58e459efc87660fb2247b805ad9664ab4f6729',
                             '_bmad/bmm/module-help.csv': 'c3c1033c8fffef924bb71342e22a0a2a8243911a0b856e2aa7804d8bb49feb5a',
                             '_bmad/bmm/v6-shims/README.md': '5495469425b50bca1cd74899c6ebfe840f137cf2a68d008bc993aa2574bd9972',
                             '_bmad/config.toml': 'ee4b98d08da4414c6983c88d4becd17e90d9e30b1dc822f80d742e9b812dbcf3',
                             '_bmad/core/config.yaml': '7186a057f980ef1d07722b17764b01c03907bbabdbdb85ecd52f888f2d58eb0c',
                             '_bmad/core/module-help.csv': '38846d71f87159345d6a6256a170c142fb3f53d9cf9c258c9ee6f26bd88a86c7',
                             '_bmad/core/v6-shims/README.md': '017900bb03baeddc0262041a6aa85bce744e8c45991dcde32ef042f9bc2a32b2',
                             '_bmad/scripts/config_utils.py': '48afe2bc18a29201e343cce3703be1e70df9c83ee74eeb68e57ef8ef42e8c651',
                             '_bmad/scripts/memlog.py': '4916a9c63ec164568cf428ce27b44d6657933f098ee3ae3970b25f0f9d8f9240',
                             '_bmad/scripts/render_skill.py': '8496d0d8b449d64c21b42a9aab3b13fc8a813a430c0695ffd84ad75bb1da7942',
                             '_bmad/scripts/resolve_config.py': '70d7577396ed40ab9462ab75dce51f852bc2e094b2d1a054214f1b30c8789768',
                             '_bmad/scripts/resolve_customization.py': 'c95aab9f2dc500d6ab7db77d6a7860028701ce414e03690613a282cc3659d284'},
               'bmadFilesManifestTemplate': 'type,name,module,path,hash\n'
                                            'yaml,manifest,_config,_config/manifest.yaml,f35203ac12ca0e15e2c4e3a865bd58d91c142df0730b2f698c58db7f157a24c8\n'
                                            'csv,module-help,bmm,bmm/module-help.csv,c3c1033c8fffef924bb71342e22a0a2a8243911a0b856e2aa7804d8bb49feb5a\n'
                                            'md,README,bmm,bmm/v6-shims/README.md,5495469425b50bca1cd74899c6ebfe840f137cf2a68d008bc993aa2574bd9972\n'
                                            'yaml,config,bmm,bmm/config.yaml,5c336426099f8fbc17eb406e0a58e459efc87660fb2247b805ad9664ab4f6729\n'
                                            'toml,config,config.toml,config.toml,ee4b98d08da4414c6983c88d4becd17e90d9e30b1dc822f80d742e9b812dbcf3\n'
                                            'csv,module-help,core,core/module-help.csv,38846d71f87159345d6a6256a170c142fb3f53d9cf9c258c9ee6f26bd88a86c7\n'
                                            'md,README,core,core/v6-shims/README.md,017900bb03baeddc0262041a6aa85bce744e8c45991dcde32ef042f9bc2a32b2\n'
                                            'yaml,config,core,core/config.yaml,7186a057f980ef1d07722b17764b01c03907bbabdbdb85ecd52f888f2d58eb0c\n'
                                            'py,config_utils,scripts,scripts/config_utils.py,48afe2bc18a29201e343cce3703be1e70df9c83ee74eeb68e57ef8ef42e8c651\n'
                                            'py,memlog,scripts,scripts/memlog.py,4916a9c63ec164568cf428ce27b44d6657933f098ee3ae3970b25f0f9d8f9240\n'
                                            'py,render_skill,scripts,scripts/render_skill.py,8496d0d8b449d64c21b42a9aab3b13fc8a813a430c0695ffd84ad75bb1da7942\n'
                                            'py,resolve_config,scripts,scripts/resolve_config.py,70d7577396ed40ab9462ab75dce51f852bc2e094b2d1a054214f1b30c8789768\n'
                                            'py,resolve_customization,scripts,scripts/resolve_customization.py,c95aab9f2dc500d6ab7db77d6a7860028701ce414e03690613a282cc3659d284\n',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'bmad-workflow',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/bmad-advanced-elicitation/SKILL.md': 'd38cb53f1c7c77f13664c340026a1a4932ae1ca5a24471eebaeb172b88c7942f',
                         '.agents/skills/bmad-advanced-elicitation/assets/methods.csv': 'd110ff5f076fb9421552b83692fde2c2d367734049169c7a55f7267a3dc7ef89',
                         '.agents/skills/bmad-advanced-elicitation/customize.toml': '735a276edd51786ccfd2c3417d9a2b9dee4244a6102698981b3888f68d979ed9',
                         '.agents/skills/bmad-advanced-elicitation/scripts/pick_methods.py': '60020ec4767894ea3d8707c4b61e78b679d434315be1dd29154bf64d88126fff',
                         '.agents/skills/bmad-advanced-elicitation/scripts/tests/test_pick_methods.py': '610099d8494529f9203d7262567810b500552bcef006b3b6388d58da3da71978',
                         '.agents/skills/bmad-agent-analyst/SKILL.md': '6bfe0ccc9d85be7c651f9d430f37192abc32c67b5445f037dfea9c87d95ce4f0',
                         '.agents/skills/bmad-agent-analyst/customize.toml': 'd6e2c5c660e8900866298961266a0b1c189c8643f2c1c9da602101e9f98d3388',
                         '.agents/skills/bmad-agent-architect/SKILL.md': '02b2361438d39181f7990940a35af73658d37831572dd5d5ab9cfca17e8f0817',
                         '.agents/skills/bmad-agent-architect/customize.toml': 'bd0ebb48faeab1e6f709d0291a13d33003484a597ed2b9c90f221b2345513b06',
                         '.agents/skills/bmad-agent-dev/SKILL.md': '5e81cd7db67a76626bef308374a06664cd52395b97c15966d09543765257f33d',
                         '.agents/skills/bmad-agent-dev/customize.toml': 'ab52d8840427e10d5956b592c34e63edc77ebdafd7b54ce60da11cf67ed72ced',
                         '.agents/skills/bmad-agent-pm/SKILL.md': 'cd3e8bf36b6e77d4b2d33c5700f0528a6cd2796b24ea22b227301bc60168b083',
                         '.agents/skills/bmad-agent-pm/customize.toml': '4613c72cfe3bc3143bd50c5732bce464c21c7266fe7dd930bc659c54e7315b39',
                         '.agents/skills/bmad-agent-ux-designer/SKILL.md': '3c28653423072119cbf8eb7b6e09a0fb6f1cd7679ee1a27735dea20a2a76c28d',
                         '.agents/skills/bmad-agent-ux-designer/customize.toml': '4acd1d9cdbf4a4328c389229ea9e9f2885d0692f8e10e3d9456da45844337c2c',
                         '.agents/skills/bmad-architecture/SKILL.md': '4a256afa9c725e0bf5b55961d21774f1eb00011dbe31509e280a955bdb1a5c09',
                         '.agents/skills/bmad-architecture/assets/spine-template.md': 'ef4ff795624eb5439fae54a06edb389feb5a0cf79cb01ae007af51109335d198',
                         '.agents/skills/bmad-architecture/customize.toml': 'e9c5f75bd6605199f3908d6a1f013d6b42fb12b6f35c9a5e13a44f7f872b7b79',
                         '.agents/skills/bmad-architecture/references/headless.md': '4db2708f335c94cb024b5eba022b1e3d88b1ec61c94c4716626d9b89684f5833',
                         '.agents/skills/bmad-architecture/references/reviewer-gate.md': 'd32e32a3c1d59b5612b947004f3f6fef1117a13ce9f1ffa428d616e0b5d4db69',
                         '.agents/skills/bmad-architecture/scripts/lint_spine.py': 'dd48be20384adfa281d295e34a39c1ae55727af7e98efe42525be31d1c5c001e',
                         '.agents/skills/bmad-architecture/scripts/tests/test_lint_spine.py': 'e86bb9a62c5cca74ddc89c843386f2b992610fcc1792d40e03bc9cd445b77681',
                         '.agents/skills/bmad-brainstorming/SKILL.md': '2657a2088329651fd06f030e61997fc9f21986588d65ce96f14043af14d8534e',
                         '.agents/skills/bmad-brainstorming/assets/brain-icons.json': 'a101c56e89f1d0f9e4131dfdfc19e10c746e3a61c3f92537d04a6f4897b7d331',
                         '.agents/skills/bmad-brainstorming/assets/brain-methods.csv': 'fff112eabca1a9cb8b190f8314bc47678becc5782a2372e11c83daa0e33b6dfd',
                         '.agents/skills/bmad-brainstorming/assets/brain-selector.html': 'c110919a3366bd96061f050f98503e3586185e3d1df5ff8b62a5a046c571a436',
                         '.agents/skills/bmad-brainstorming/customize.toml': '313c3b348473cd40ba02ceae4b299c617300af78debb2f5585c8d3941cc2d8d3',
                         '.agents/skills/bmad-brainstorming/references/converge.md': '1528c32ddc64f8061fec663306f7208d2fd4d4a90e660552b8138bda7e452dc0',
                         '.agents/skills/bmad-brainstorming/references/finalize.md': 'b6074e7fb4d86ffcf899abc50b9049b4a1f6fe550917f4be7a1c7a888477e07e',
                         '.agents/skills/bmad-brainstorming/references/headless.md': 'b8ea5951199cff7e4813e06aef35683ca0658230fa015e358cacc466b1138a42',
                         '.agents/skills/bmad-brainstorming/references/in-chat-techniques.md': '18239464e3e4f00ea9063d015d26d6b0a696b72e7e3c5be92352da6db9a3f244',
                         '.agents/skills/bmad-brainstorming/references/mode-autonomous.md': 'd815d2c7f0f8cc0cdfa7c619eaf61f59fd78142f13c69365eda257da38b97bdf',
                         '.agents/skills/bmad-brainstorming/references/mode-facilitator.md': '1b908498d285d190859aed00c3ba5b399d7f6aa8e94d54e95456d15cd6fe6073',
                         '.agents/skills/bmad-brainstorming/references/mode-partner.md': 'caa0ed378c116def4de382f4e5a95173c6ae6cc5464f1792e7d8196360f79c8a',
                         '.agents/skills/bmad-brainstorming/references/resume.md': '0f79535d72eefe6c55bd5ae47fe4753de8d27235cf129f10b2c596a124c26526',
                         '.agents/skills/bmad-brainstorming/scripts/brain.py': 'f81b28fe590f607b95c7218a7cdd6fb6eb91d3a76b9671acf54bcaf36fd4e6ca',
                         '.agents/skills/bmad-brainstorming/scripts/tests/test_brain.py': 'b219da8e5e3ccd4ebae95fb02bc5683d6b62593d71db75a712adc7a1b9017bc3',
                         '.agents/skills/bmad-build-auto/SKILL.md': 'ea798a5f7df3b11eb73555a54fc0516c70d8f98739bd7857d968297b26f6ef94',
                         '.agents/skills/bmad-build-auto/compile-epic-context.md': '64d13b41974cfa0dfc1de64b6fbd8365e9b99f91c7c98f0ee1a9fbd018f324ca',
                         '.agents/skills/bmad-build-auto/customize.toml': '31417a8239f213c00621bb9016c3099631ae7ef03731ce5be209a5668a5730ee',
                         '.agents/skills/bmad-build-auto/references/claims-check.md': '50ea17cb89a78ef815286dde2dabfd09f1dc9841d07a10857f88b39ab7b9bd2a',
                         '.agents/skills/bmad-build-auto/references/deletion-check.md': '0f1f124e4e957147e89164a272b10bedc694ad0d9ad2618c8610ac74ee9cb0da',
                         '.agents/skills/bmad-build-auto/review-prompts/edge-case-hunter.md': '8fc046af1cbf4ecc928207cec75e29c3c260adb86cc7da77537ade3b3a3b9448',
                         '.agents/skills/bmad-build-auto/review-prompts/verification-gap.md': '45ab0b8c4c56c5c055c97a293a8591a67e256d0b1a2058ce1f093cd866be8d03',
                         '.agents/skills/bmad-build-auto/spec-template.md': '59a046df2773ec05af0688823d17238bfde2bb54c0c3b3eff6acec4856f1eb7a',
                         '.agents/skills/bmad-build-auto/step-01-clarify-and-route.md': '50674ecef3b4b7a26b993685c9a79ccd87b00b2255d51b6b9c13ed32aa6d1ffa',
                         '.agents/skills/bmad-build-auto/step-02-plan.md': 'a08e303c10f88dbfce88c55044757ec5059afe338793eb414e1ddb0b7c324625',
                         '.agents/skills/bmad-build-auto/step-03-implement.md': '0dc9c9634eca148baaec03e7d154840a14101f92492b7ab469625bf13b4e2ab5',
                         '.agents/skills/bmad-build-auto/step-04-review.md': 'c5530c50c89f197720275b83466b382f896fa27a0bba30d4b75c6af162148cdf',
                         '.agents/skills/bmad-build-auto/workflow.md': '611f429206029a903ec9433ccdfd9b186fbafc6dc95da0a21fbcdf5965ad25ea',
                         '.agents/skills/bmad-build/SKILL.md': '1cdf5406965ba24236d2375739d839699eb56b619834490539d1bd3d5111f890',
                         '.agents/skills/bmad-build/compile-epic-context.md': '6793b15ae85766cee529e6b349e45f2c6ec9e3212019611c29e8c77b4dc4b924',
                         '.agents/skills/bmad-build/customize.toml': '0ee9b033a40640420d1dc3411de7428146d00bf8c1409c9a9cfe6c1743cd53b9',
                         '.agents/skills/bmad-build/references/claims-check.md': '50ea17cb89a78ef815286dde2dabfd09f1dc9841d07a10857f88b39ab7b9bd2a',
                         '.agents/skills/bmad-build/references/deletion-check.md': '0f1f124e4e957147e89164a272b10bedc694ad0d9ad2618c8610ac74ee9cb0da',
                         '.agents/skills/bmad-build/review-prompts/edge-case-hunter.md': '8fc046af1cbf4ecc928207cec75e29c3c260adb86cc7da77537ade3b3a3b9448',
                         '.agents/skills/bmad-build/review-prompts/verification-gap.md': '45ab0b8c4c56c5c055c97a293a8591a67e256d0b1a2058ce1f093cd866be8d03',
                         '.agents/skills/bmad-build/spec-template.md': 'e217325964857ebd90a9508bf171eddc2c4ad1b0b9b32a119775ac5c015695fd',
                         '.agents/skills/bmad-build/step-01-clarify-and-route.md': '1e8095b08e9e9c57d9b24678b524e07d0b6bbb5af72ba213622f12a1c7d909cc',
                         '.agents/skills/bmad-build/step-02-plan.md': '5c999430f818f58fc5e4f64309a1b0f81358ce0ddcfbd3f44b25d56279ef25d8',
                         '.agents/skills/bmad-build/step-03-implement.md': '15fd02d2f655d4102c515134ed6aa40cd055bd9d811e49d529512f8f36d09b03',
                         '.agents/skills/bmad-build/step-04-review.md': 'f6b3f3fa5d3af0b324db2efee9351d4c348bdc0dfa4dad6c058eb4fd37921333',
                         '.agents/skills/bmad-build/step-05-present.md': '551e0847e2ebb64575180a5dacca5786b9b9d7825dcd986e1b3b58442eaf713a',
                         '.agents/skills/bmad-build/step-oneshot.md': '241fa52e227c048a5d8e4428bef0f153267475f697640899deb218b58ebfd378',
                         '.agents/skills/bmad-build/sync-sprint-status.md': '7ff44d21f5d813f4993780271eec8df2fce1373f525ff80e595b7c10618c4c36',
                         '.agents/skills/bmad-build/workflow.md': '481ff00ef349a9c7845feca02bbfd5722b1e318ccabac858355da6c90c2d8a39',
                         '.agents/skills/bmad-code-review/SKILL.md': 'de287a30b672fd3c435f68f644d231091fb788e6d857a3e9f9d1ca22e67e13c1',
                         '.agents/skills/bmad-code-review/customize.toml': '282d9483ccb74acab1efb965ce10ebd6206a61da94da245a705a6358dbf0dc2e',
                         '.agents/skills/bmad-code-review/references/claims-check.md': '7be5d35dd90a1950addc2062acdf8669026b239117efe1e398da1e8161cfa6f9',
                         '.agents/skills/bmad-code-review/references/deletion-check.md': '0f1f124e4e957147e89164a272b10bedc694ad0d9ad2618c8610ac74ee9cb0da',
                         '.agents/skills/bmad-code-review/review-prompts/edge-case-hunter.md': '5f4572d57340b4c0d155f33454d644a44af101cd7fd02a01591be68a4ebb8b7f',
                         '.agents/skills/bmad-code-review/review-prompts/verification-gap.md': '06f6184d7d94c808970d0146cdc4585dfd66b94a7b7ab2988277fb6fc4208508',
                         '.agents/skills/bmad-code-review/steps/step-01-gather-context.md': '51941fd52406cf075ac9172cdcbeebefe85df91ea818ad8ec723724de67a1831',
                         '.agents/skills/bmad-code-review/steps/step-02-review.md': 'f2b8e654cf595746656d9861c4ac722f65b02939c53900f4f6d8b24988b2155a',
                         '.agents/skills/bmad-code-review/steps/step-03-triage.md': '337ac3ad2cd8cabb34f4e47c8778cfd703f919753573dd9d708b7218fd5de684',
                         '.agents/skills/bmad-code-review/steps/step-04-present.md': 'a9619f7df9b9112c0e42ee71a362f73dfa38ef6dff7b403975dbd6d2480a8d9f',
                         '.agents/skills/bmad-correct-course/SKILL.md': '1a56020a13e17f20a420a206ad6d7b09b5f91fe89f6a14918ad77e691bd05686',
                         '.agents/skills/bmad-correct-course/checklist.md': '3e082b95def90ccb876e3101ce0bbaf797a0f03a9471e1347361897f27977327',
                         '.agents/skills/bmad-correct-course/customize.toml': '9990c3d4a1aa90a207f7e3380a7a48a5c9c005702194f63c6a959a4b1a18586f',
                         '.agents/skills/bmad-create-epics-and-stories/SKILL.md': '506d7c2e02a301e012eb75b918c00e6f53ba1dd6295f6e313cc7bf0a77c83261',
                         '.agents/skills/bmad-create-epics-and-stories/customize.toml': 'e7633a4e6e33161c7cb13034e5132d9d29f8a7031e75765d16a60724f2089557',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-01-validate-prerequisites.md': '7181608c1ee4e55c084c6627d68fc55a8a0b6917e489f8ac77531a0530428a30',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-02-design-epics.md': '7c66987808c1f84e853fe54b7aff26d209196d450b5644704110f124a15179bc',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-03-create-stories.md': 'c5b787a82e4e49ed9cd9c028321ee1689f32b8cd69d89eea609b37cd3d481afc',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-04-final-validation.md': '12b869b4f0531c9cf68a6b7a076409643858de245916ad4c1651e42189c86835',
                         '.agents/skills/bmad-create-epics-and-stories/templates/epics-template.md': '542c4fd17c2382ea36aa3b7b15929f3fd62a8092631c60c83a78629bfc56e368',
                         '.agents/skills/bmad-customize/SKILL.md': 'ef42ffe69d1758ee12f22d6c143262926f715dd13fecb874c8a5971916d41598',
                         '.agents/skills/bmad-customize/scripts/list_customizable_skills.py': '9bfc913e6d23c3553096a68844823b022505f8b2ca7844eccdaf40b1b9288992',
                         '.agents/skills/bmad-customize/scripts/tests/test_list_customizable_skills.py': '24c3d384b3b5d490b7335c17866bfe0425af253ce669c32382fa88feb705934d',
                         '.agents/skills/bmad-deep-recon/SKILL.md': 'e6de27d7c037e2951c5684d976186f6772cc724279af4b3cac05e21c42156db5',
                         '.agents/skills/bmad-deep-recon/assets/research.template.md': '87d7cfa85fa5036b5a309b7bfb88f7934f50bb81f3cff02d2b49b4c7345cfc38',
                         '.agents/skills/bmad-deep-recon/customize.toml': '24d1383066034fd4fcf282279aaf0d29d21910fd1247dfe3dbad74a70e78814d',
                         '.agents/skills/bmad-deep-recon/references/draft.md': 'ac19b33a00ca529c3281df6076f87a833a3b11fc30915ca2c6e7590f7986b90e',
                         '.agents/skills/bmad-deep-recon/references/finalize.md': 'd2ba4bee615dfbca6e7725179fb5ebd856dd34a54ba3f306e25255dfd7b1d126',
                         '.agents/skills/bmad-deep-recon/references/html-briefing.md': 'cd3a88c1a5505fa7f1b715afc3adb34f3d64ade66f4c6b49a59f7e8cfcbe38d4',
                         '.agents/skills/bmad-deep-recon/references/lifecycle.md': '2315fd9cb9223504639616b861ad593bfecb53d605efbd598ae2cf94fb6c4cdf',
                         '.agents/skills/bmad-deep-recon/references/process.md': '9017d04774807a29103ea97331e555e2793f90098af65752b72f3ee09df85906',
                         '.agents/skills/bmad-deep-recon/references/run.md': '8e259dc88820ac989c79620af5c37e24f00df21ac4af308ce3563c0e66c9406c',
                         '.agents/skills/bmad-deep-recon/references/selection.md': '2b488c08f9550afe7fda32c2dc5d4591927afd7b9ad507fcce0ae8593c4b9d31',
                         '.agents/skills/bmad-deep-recon/references/synthesis.md': '4d9ef1247ab45241f919010e94c99699abc0a6e18b5bd68fa93ae54afe59d172',
                         '.agents/skills/bmad-deep-recon/references/verification.md': '0393ded4828fec69a4819d7236827910d641d09c3b61144c0211a9a78776fdd2',
                         '.agents/skills/bmad-deep-recon/scripts/recon_kit.py': '20785a881170b3d54122967041016a3986f4ebab407c979409c4f22c8b1c1d49',
                         '.agents/skills/bmad-deep-recon/scripts/tests/test_recon_kit.py': '1b4ddf482dd2d11a214ee2f821c35d7a8c41905b5d8d9cc69a293304bb8a1665',
                         '.agents/skills/bmad-deep-recon/types/academic-lit.md': '514b0b7b1184cb95363dedeb0c2298a9bf5c430c74146fe2114f31780fadb325',
                         '.agents/skills/bmad-deep-recon/types/competitive.md': '39b53df87d295fdc4388719fcdf31ad2221e64afc136e669207f46d2727a3aec',
                         '.agents/skills/bmad-deep-recon/types/domain.md': '3a34b2e62c3589f8c8d01158357ee9fba32648c9fdfe70035bb3ca971862896b',
                         '.agents/skills/bmad-deep-recon/types/market.md': '81ac04499da441857672e29fcd7169436a7e239e67194288ac0d526ec514cb5e',
                         '.agents/skills/bmad-deep-recon/types/technical.md': '55f71428c70547b89d67ef0c6cdad59caeb0ee21082cd1230c05618ba8d04707',
                         '.agents/skills/bmad-deep-recon/types/user-voice.md': '1831ce46e53e8c68244d28e336c5ef9e53e64f21a00b74a817b9b2924c1e8e72',
                         '.agents/skills/bmad-forge-idea/SKILL.md': 'e44d0008db0c0b30f3fa533e987efe66b2c852530b70fed03f0d4d9cbabe2b4b',
                         '.agents/skills/bmad-forge-idea/customize.toml': '839f57b89c8b04038fa795525f55799ee5c23431b17d429fe668880e78399ef2',
                         '.agents/skills/bmad-forge-idea/scripts/resolve_personas.py': '9273c71595d6317e0a1035b1a632a47a8943379797d0a4db0d2842e5787c31cc',
                         '.agents/skills/bmad-forge-idea/scripts/tests/test_resolve_personas.py': 'f8d040801d53e48c1aec147d1e28c5b279e459f49ea1fd1673dbd7e340022a99',
                         '.agents/skills/bmad-help/SKILL.md': '72573fbbd205cab6119015b7a20951055c7f1f583162674ebed7a68368dc889c',
                         '.agents/skills/bmad-party-mode/SKILL.md': '7bf82a11627595762244c969cdcc836869c935c5aa99a7c5ec5657581c1f4dd0',
                         '.agents/skills/bmad-party-mode/customize.toml': '332aca1a85a681ff38a78850deb552e954d6a7d0b32f8d22caf9b2b2324b4e24',
                         '.agents/skills/bmad-party-mode/references/create-party.md': 'e7fdf66d779e7e08d1cd4fbcbb63b78ba2dd8b1d781af0d0da8bea8c7110176b',
                         '.agents/skills/bmad-party-mode/references/mode-agent-team.md': 'def759a17f4bb45463b68fb74c2b828b0a4241720b2b6cc1c9c611a1016ae9d7',
                         '.agents/skills/bmad-party-mode/references/mode-auto.md': 'a37fd24f76dfcde385890d5c5947bb6f40ca44bea86c805d267b6ae3aab39f70',
                         '.agents/skills/bmad-party-mode/references/mode-subagent.md': '86161b24a0b13b8f9cb9309042e4249d8caefff8cc33728b084cd2ec22f9d2e1',
                         '.agents/skills/bmad-party-mode/references/party-memory.md': '800b4b4b920bb881a7b32aaabca8559a98273799b2476d83a23e290e301fb315',
                         '.agents/skills/bmad-party-mode/scripts/resolve_party.py': '810d7838ddb4623c60e29639a3b2484ae140ebc59147acf98bfb934b55577a58',
                         '.agents/skills/bmad-party-mode/scripts/tests/test_resolve_party.py': 'e2a7b1bbbe011b56a917dc54449fa29fb3df8716674a5998a32a50e3b5ee60e7',
                         '.agents/skills/bmad-prd/SKILL.md': 'eafebb3fbebc4e276a055ca9916e20e36e95dca03f819eeeaaf80a3a9c16f07b',
                         '.agents/skills/bmad-prd/assets/headless-schemas.md': '8d3621333a72400512bd62511bc4c73fc745711505e1f852c697ff8c5fa2de93',
                         '.agents/skills/bmad-prd/assets/prd-template.md': 'b6fe8fc1390b8e46961d5eb5e6f2fe6c65dca2f30623d492677672e02868f7ab',
                         '.agents/skills/bmad-prd/assets/prd-validation-checklist.md': '41d9f09064772a92ec908d970618e47ba63dc86b5c5a1a21d5a2c676d3ba8e3f',
                         '.agents/skills/bmad-prd/assets/validation-report-template.html': 'a80becdd8205d2d7c18738855830b096172a496b96b5ca8a0820ec55c9bb8bf9',
                         '.agents/skills/bmad-prd/customize.toml': 'd23707fe7ff5f5060a05b5b8bda3f170b9b1d9be61e409e9f7ae91f83572db6a',
                         '.agents/skills/bmad-prd/references/headless.md': '4dad58ebee63933a53179016513ff94d143ce9f68e226489d390e2c36bf1d848',
                         '.agents/skills/bmad-prd/references/validate.md': '19b2fa66d58cb4fef3d920cd09c81f8add4ee44dd4191bec87eaba84c2093338',
                         '.agents/skills/bmad-prfaq/SKILL.md': 'e16d295601af1ebdf94e2f6da2c5ef3235029997bd78d0cbdab592e3d839dde7',
                         '.agents/skills/bmad-prfaq/agents/artifact-analyzer.md': '7bdc44830f8d593346ec0ee15e36e1e431432fcc6c38b70bb861999315c9cfa4',
                         '.agents/skills/bmad-prfaq/agents/web-researcher.md': '6e9127bb9bd3e4b15c701e4ced9eef328769262cd34eadc221bebe954c1f3aef',
                         '.agents/skills/bmad-prfaq/assets/prfaq-template.md': 'b27e6964f0437ab4e78c8c0ffbe5052c28e3b3ef2fc811726cbb394d5a5c7559',
                         '.agents/skills/bmad-prfaq/bmad-manifest.json': 'b67b016cd68535a97bd9164c237fbfe19a5b26bc1a3f0afe203fecfa40aab6ff',
                         '.agents/skills/bmad-prfaq/customize.toml': 'b764b9ea360734d681115b958d0ccd478f1b56ce0045ecd6f71311ef005d8980',
                         '.agents/skills/bmad-prfaq/references/customer-faq.md': '96f8565197649c58908a1d61b6cd805fd01f57da7945ba889c18d087ad597aeb',
                         '.agents/skills/bmad-prfaq/references/internal-faq.md': '26eb83f844cda1ed8efb50f4703d61713ada8a64bd27eb387f759f858b5748de',
                         '.agents/skills/bmad-prfaq/references/press-release.md': 'c406adb0e2d2cc326cbc45d0174f89d014523448ad82bc272293999d22aec596',
                         '.agents/skills/bmad-prfaq/references/verdict.md': 'c962ce2c97e824cb53dae70c898153ffac3ea56b56565012ca2b96bb21c9618c',
                         '.agents/skills/bmad-product-brief/SKILL.md': '88618d280e90cdfdf8ece62f0e9e6406e3db2d93b70aad66806d1be4bdfa3dbd',
                         '.agents/skills/bmad-product-brief/assets/brief-template.md': 'bb28edf75d023067551c8d417b19b8803324e7acfb2ad0c80f882e9134f4c1f1',
                         '.agents/skills/bmad-product-brief/customize.toml': 'bef95b0ab71793d214ec59ed7397a25f7253e63fad5d60570248614db6186905',
                         '.agents/skills/bmad-project-context/SKILL.md': '50b0ee0f4905273dd7f8a57a4e79b2ff47eabb074b6f4bce8242b950b37dfb63',
                         '.agents/skills/bmad-project-context/customize.toml': '9bf8a3aa919832cd8932853da550fcaebd06a9e13c0cde453f4379d8327f9c0f',
                         '.agents/skills/bmad-project-context/references/best-practices.md': '850c45d2e1de44b1cd8e3b06b8175df53aac8983326d73351eab547bfacc532b',
                         '.agents/skills/bmad-project-context/references/template.md': '5e2bc291e734a481fd2925877adfbe82b03313f300baf67dfdb6fa22a1181601',
                         '.agents/skills/bmad-qa-generate-e2e-tests/SKILL.md': 'f8f6a62c390f0cf7fc88ea04fa1bc236dedde27cdc1ce95cdb6ebc1cd8f33251',
                         '.agents/skills/bmad-qa-generate-e2e-tests/checklist.md': 'b58f810aeb1040c2f6758c88aa133afce72f8cc178d3d97ff0fbaa3d943057dc',
                         '.agents/skills/bmad-qa-generate-e2e-tests/customize.toml': '4fbbd9d96e5af24ae012d33e59582b88867e8203dcd5a29f0d46b42ef6d747b8',
                         '.agents/skills/bmad-retrospective/SKILL.md': 'd3f12423a0e456a7c2a25d5aa005df4eb4cb8c0b5cd400755b026c3c100b99dd',
                         '.agents/skills/bmad-retrospective/customize.toml': '33ce7da5bad6dfe1791218d8d607b749f9b58586b232df7ea0d3263ec50ec466',
                         '.agents/skills/bmad-retrospective/references/acceptance-verdict.md': '09a65007c39af83e01e039331c252e6e670b134cd5e2a4b5e05ac9d9fb7e37f1',
                         '.agents/skills/bmad-retrospective/references/aggregate-views.md': '5b278afce4a53692d8715b4af178e4233da0876921dc3154b5763d056cb5ff0b',
                         '.agents/skills/bmad-retrospective/references/evidence-gathering.md': '575bace78d7c03c48d86a209dd664f7dd22295a222b75e6d6298894cb7b7ce00',
                         '.agents/skills/bmad-retrospective/references/retro-document.md': 'de8164664cd2be7f73b8ba5552e9e0f58816d2a7c4be8efc7715461846bb7001',
                         '.agents/skills/bmad-retrospective/references/team-discussion.md': 'a9c504c436038c7e47d08322413aa3c213d2859b36ae30e873cb8c60fd9e008e',
                         '.agents/skills/bmad-retrospective/scripts/git_evidence.py': '2acbb8b5804d0680b5939629a0c3786a72cde30f5f2cecd75858325c6e778d89',
                         '.agents/skills/bmad-retrospective/scripts/sprint_status.py': '7c9f0a514a6e0834182f3c30485de49e0a4decb9be51027cc8be58aecdb9fc44',
                         '.agents/skills/bmad-retrospective/scripts/tests/fixtures/sprint-status-template.yaml': '64b1a937e1fe03b8b8d158e3b1caeb89e7d51692a56c16038e2af091decc553a',
                         '.agents/skills/bmad-retrospective/scripts/tests/test_git_evidence.py': '0abfc8fad338830fc2db656d3ccc500631b0ea7a2ab87d853c13a6bbd46ff13c',
                         '.agents/skills/bmad-retrospective/scripts/tests/test_sprint_status.py': '23da16cca54904a256fcf88fd8f912c3f6091ea343768c241bbd2aeebbca2af3',
                         '.agents/skills/bmad-review/SKILL.md': 'c571dd7d3aa75f3b40749cf9db352c5e76244de22139cfb13c26629d28be1fa7',
                         '.agents/skills/bmad-review/customize.toml': '005dde84f09c0b1ab0ef0ee87f1ed1985922c893089cc3595157611fb83b3ebd',
                         '.agents/skills/bmad-review/references/editorial-common.md': 'f0cdc72ea345b2c5dc3001477b3dfcc909ca11b78f7db8865b6763d18ffc66c8',
                         '.agents/skills/bmad-review/references/lens-adversarial.md': '7c5ce97ab2f3ecb96ceb6aa76417f68c1b7df535edd3cc51666d8e1216e6e557',
                         '.agents/skills/bmad-review/references/lens-edge-case-hunter.md': '5f0c4778d7b393d11156af8c1bd9bf88aafeb9d50fff5f460ca67df50d927e7d',
                         '.agents/skills/bmad-review/references/lens-prose.md': '4cbcb1eaea8567d272f5db7c6cdfd74ed5a8aae6831053cb2f01cbfc2cb98b98',
                         '.agents/skills/bmad-review/references/lens-structure.md': '98c08221f517133e57ef6325013935360c3365ebd7dcb8411b2050d7df507ee3',
                         '.agents/skills/bmad-review/references/lens-verification-gap.md': 'e7123d81171eeeee1b3782d13d94c2988969fe357dd71949131a5eb97803e2c6',
                         '.agents/skills/bmad-review/references/structure-models.md': 'f84f85070e1af75f2482757aba9d37d69d805a20826d185527e598f2ba6b9292',
                         '.agents/skills/bmad-review/scripts/tests/test_word_metrics.py': '3b5a285d3c9f611b3cda8c9c1d52d6b214c1f72e6e64a94ea5b0e220db5a8765',
                         '.agents/skills/bmad-review/scripts/word_metrics.py': 'fb45007a7f3cfc18d13ee8bd4787facdaae297570193bc769456297dd33da78b',
                         '.agents/skills/bmad-spec/SKILL.md': '46a2c3d5541d63af1520fac6b7abfff161a94b52fed51df6454115e3da5639c7',
                         '.agents/skills/bmad-spec/assets/headless-schemas.md': '83afb3614716db2347d83586a67b9c524492dd50db5282436ccb35c99fb5f08a',
                         '.agents/skills/bmad-spec/assets/spec-template.md': '4b3a032c045fdd0903933446fc07f93e879997f28a0294ed4344da71192b20ee',
                         '.agents/skills/bmad-spec/assets/stories-schema.md': '4f8137c00e2710288354a4466d1cfb90704f4b2a04bd3b63924218fd589cc6a9',
                         '.agents/skills/bmad-spec/customize.toml': 'd0f1f926bed79d514f8fdbc458a1883167fb64663bf2464c40e3c50dc2dcdbea',
                         '.agents/skills/bmad-sprint-planning/SKILL.md': '391fdc181c605ec9da99028f9a82776410c86b50d2cc273b2b8d3d4b266a2012',
                         '.agents/skills/bmad-sprint-planning/customize.toml': '54c7f6a8af77ff7ea6c9dbb00b515023999e011aabc802b7b328e82f505b0299',
                         '.agents/skills/bmad-sprint-planning/references/fix-sprint-status.md': '0406c31b70da33e2a354d9785f43d8f9918f4b923d0aac2ebd1e3707ebad5806',
                         '.agents/skills/bmad-sprint-planning/references/generate-tracking.md': '4dbf7aca26d0e6e893f288fc5e6158dbbcd65f77bbaf95e941ca705abceb1741',
                         '.agents/skills/bmad-sprint-planning/references/readiness-gate.md': '7d58ea61fafe3c1d8218203abc7512e322ca384c78d9e71829df55dfabe1245b',
                         '.agents/skills/bmad-sprint-planning/references/status-view.md': 'c3547e221ebf6e55c874e2ada3e8c18198835213c76f0bb2e0e64150aac355ab',
                         '.agents/skills/bmad-sprint-planning/references/validate.md': 'ac680fa0a0f945a9bc0fc89ca709b2a8e6bc3b2617cd0d3d730378c4b5edd86d',
                         '.agents/skills/bmad-sprint-planning/scripts/sprint_plan.py': 'c4e4daf4200f233501a069a43db56d097c5d4e71f74cd29f132f88b83c2fc95f',
                         '.agents/skills/bmad-sprint-planning/scripts/tests/test_sprint_plan.py': 'f1c3b640e156946b0a234e233807b2a3983cb0d3f2d13dbb9830fbe0c67e5238',
                         '.agents/skills/bmad-sprint-planning/sprint-status-template.yaml': '64b1a937e1fe03b8b8d158e3b1caeb89e7d51692a56c16038e2af091decc553a',
                         '.agents/skills/bmad-ux/SKILL.md': 'b437d6ad812577e31cb6845c2417aa491c2f3a17487aa43ed7960b3b9299b564',
                         '.agents/skills/bmad-ux/assets/color-themes.md': 'ccb6e4ef47a196476cf9392d788938ad3ca8d07b9ce095b7c092dcb4e06735f0',
                         '.agents/skills/bmad-ux/assets/design-directions.md': 'eab73b948da76a27abc908e1e7d6b124e8ff0362e6dd1990f7e60b9541cbcb98',
                         '.agents/skills/bmad-ux/assets/design-example-editorial.md': 'a659166845b1a4ed3f9aef942c5935537a97382b10303684fbb78ed86265870e',
                         '.agents/skills/bmad-ux/assets/design-example-mobile.md': 'a93fb9f114f2e83af0c961c0d7909b3859fc80bcd713715517cd639a53a0372a',
                         '.agents/skills/bmad-ux/assets/design-example-shadcn.md': '25e0dfb2bb21483973a8f0a6ed650288b3dc2ae5ed02aa0f091bb9b6b0b39fc0',
                         '.agents/skills/bmad-ux/assets/excalidraw-wireframe.md': '660bbcdebff50cd044a3752eda43f3cb303aca4b0f521b55a270da93b89ddb18',
                         '.agents/skills/bmad-ux/assets/experience-example-mobile.md': 'f8cd54c92193cd8c34a472df9c212ac7330976f6a115b729721dcb60034dc4f0',
                         '.agents/skills/bmad-ux/assets/experience-example-shadcn.md': 'd6ca16e87b768e8b41f352c02ee08af21d7cdac04ca21e6ae1556864b4d27590',
                         '.agents/skills/bmad-ux/assets/headless-schemas.md': 'e3a773dde85286f1a6f6dd8b26fc17e09ccea96f6257dfe7fb436353cd79242d',
                         '.agents/skills/bmad-ux/assets/key-screens.md': 'ff1c5060673dd595edd61e76806bae876264ec6895c2eaadf8a6190785bf5f7b',
                         '.agents/skills/bmad-ux/assets/validation-report-template.html': '8656945636fabe96624f8ef8fce931b073b5aecbe42d490584c1d5c7f31e1353',
                         '.agents/skills/bmad-ux/customize.toml': 'e85144ed214dc1e002ee7fc6589a0a7ef352c5f79ab4cb37a4e05ee8e245549c',
                         '.agents/skills/bmad-ux/references/creative-tools.md': 'e281292d7c0fdecdbb67ca9b7d95d4bed803626ba5edfd8dcc99146fcaa118e6',
                         '.agents/skills/bmad-ux/references/design-md-spec.md': 'd04d5f663607aba3f3181e818ae33856e6caf5e560dcb16fa64ed80b7cf3d590',
                         '.agents/skills/bmad-ux/references/headless.md': '8da7e23d269b1644f45b5104a243a6a27fd8d075aebb95d9b7752f0d143f0f5d',
                         '.agents/skills/bmad-ux/references/validate.md': '7c2189d9ac1585d9408b6ed0346ba564869e7db89dba8f81044db3431cfcee65',
                         '.agents/skills/bmad-walkthrough/SKILL.md': '2294849558370f1219e5fa7306b731b30aedb0e6649eeeac95d88bff1301d938',
                         '.agents/skills/bmad-walkthrough/customize.toml': '2a4b14c5b25729a2d8fa9d9762ab3f12ac9429cfc6bd31fd80a81d86eed98630',
                         '.agents/skills/bmad-walkthrough/generate-trail.md': '4a5936d86fbe5a85285b4535097b1e2edda8849da35586f4b588a982d7224459',
                         '.agents/skills/bmad-walkthrough/step-01-orientation.md': 'd9e3b949c36d49a025f3535773af2b51888fe4ce616b6d6d69683a122716b1d2',
                         '.agents/skills/bmad-walkthrough/step-02-walkthrough.md': '66cf893f8f968ee81034e9ccd8c20415692c3a8c23a9a143c2245fe6c800acdc',
                         '.agents/skills/bmad-walkthrough/step-03-detail-pass.md': 'd48163b9f305f15af57729a8443142e47beb6c3e977554afe12b39ee49cb9fc0',
                         '.agents/skills/bmad-walkthrough/step-04-testing.md': '28a56e868968ea2d18add0df8c4bccced0f94b698e218df3d45ddac072ce369c',
                         '.agents/skills/bmad-walkthrough/step-05-wrapup.md': '5bfe0f9240ae073f1b5c843d172c11e76cbe6067e8df414ea6a338c81f113f5d',
                         '.agents/skills/merge-reviewer/SKILL.md': '053160628d0ebafb6232ee157fa5b997f4e7a0fcc57b350a5ba751f453971fd8',
                         '.agents/skills/merge-reviewer/VERSION': '065582655aacd6fc83ff742a5715c04bb4a57395bf3ee4559798fa42c2ce4589',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'ae227e5e75073a0026b71673035d78c353864bd2e7ca02cb70274ecec50b3fd6',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '9f73cf2e4612cc5bea51e91e4e32dfb9cd857c532ffaa01d85a9aa026fa3741d',
                         '.agents/skills/merge-reviewer/references/usage.md': 'f2d216cca6bf11e70629166ef59b8967633429716720c7decffa356c85d4107b',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'f89ff4cf4d9d037f57f17af850061fcb30d7a804a995473f1f3669a6f9a9d92a',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'fa23f7f1ef90f218435894075e7fdf5a5c332341911ea917d19b2c05c2394a47',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'c117d7fd6f5dba50da998da576775d2c72e19324cf15c46a5f426f2fcf0dfc76',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'ba48f6f210b5157c2a59e6d949365764c665c0d2438d80803acb8d60b3ee56ec',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '3c2e323ecf4d3b8274974b18ad82a33e2c25fac227697c66fd0470aabde65c46',
                         '.agents/skills/release-reviewer/VERSION': 'f62184cee8787f2f6941c82041a5725d4edc9aa293ebe5dbf664406e82ec1fe1',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': 'ba14f8c8eb4c2d89a909d69cacd9a058a18ed2f6a6b3e0b4067d47587c7926c3',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '355d5b2d780d84bb941db7dc24274750a4989ed450f7ca9fa3403d322a0ed723',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '044dcf261c85c3f733b5674c12b8859158abe0dd7b89f8d9c5603cebc1953bc2',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'aec585e105a0446d485ee1a0153ef1a8ed37455106b726053a96b5c6a11019f6',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
                                                                                                     'upstream_sha256': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4'}}}},
               'payloadSha256': '75c23c518209088710be3f34788a4fe4a0327c23e5aa8318c495b08058380e6b',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': '3a634fd019f17db59581653e408f16bfbe91f12e9acda7419828606ec847ea1a',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': 'c5cdff6d85903936e6664b23423351e3bae86bbd73b0a0bb7794e65366373ef3'},
               'skills': ['bmad-advanced-elicitation',
                          'bmad-agent-analyst',
                          'bmad-agent-architect',
                          'bmad-agent-dev',
                          'bmad-agent-pm',
                          'bmad-agent-ux-designer',
                          'bmad-architecture',
                          'bmad-brainstorming',
                          'bmad-build',
                          'bmad-build-auto',
                          'bmad-code-review',
                          'bmad-correct-course',
                          'bmad-create-epics-and-stories',
                          'bmad-customize',
                          'bmad-deep-recon',
                          'bmad-forge-idea',
                          'bmad-help',
                          'bmad-party-mode',
                          'bmad-prd',
                          'bmad-prfaq',
                          'bmad-product-brief',
                          'bmad-project-context',
                          'bmad-qa-generate-e2e-tests',
                          'bmad-retrospective',
                          'bmad-review',
                          'bmad-spec',
                          'bmad-sprint-planning',
                          'bmad-ux',
                          'bmad-walkthrough',
                          'codebase-wiki',
                          'merge-reviewer',
                          'output-style',
                          'release-reviewer'],
               'upstream': {'bmad-method': {'asset': 'bmad-method-6.12.4-codex.zip',
                                            'repository': 'bmad-code-org/BMAD-METHOD',
                                            'sha256': '3a9172ced5a3d0f4b41774d2477d0178476bbc822b0148784e75c69ec86bd819',
                                            'version': '6.12.4'},
                            'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '611b9727d723dec1d231654693b098f1b4454a20c893d3fd6f88f6f7b0d65aab',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.14.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '12896a08c49ce5c4aeacf0354fa125084b03bc7ee564156c660a671badf11cd3',
                                               'version': '0.14.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.4.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '3ffc3bada0bd961cc5a7681e0e7ffd6743abfb6d3032198561caba2d5bdd7f39',
                                                 'version': '0.4.1'}},
               'version': '0.26.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': 'ac6040dac0b06bf74fa60c914d7aa48217a10e9cbb4ce2e83f08c5160b95f46d',
               'bmadConfigTemplate': '# ─────────────────────────────────────────────────────────────────\n'
                                     '# Installer-managed. Regenerated on every install — treat as read-only.\n'
                                     '#\n'
                                     '# Direct edits to this file will be overwritten on the next install.\n'
                                     '# To change an install answer durably, re-run the installer (your prior\n'
                                     '# answers are remembered as defaults). To pin a value regardless of\n'
                                     '# install answers, or to add custom agents / override descriptors, use:\n'
                                     '#   _bmad/custom/config.toml       (team, committed)\n'
                                     '#   _bmad/custom/config.user.toml  (personal, gitignored)\n'
                                     '# Those files are never touched by the installer.\n'
                                     '# ─────────────────────────────────────────────────────────────────\n'
                                     '\n'
                                     '[core]\n'
                                     'user_name = "BMad"\n'
                                     'communication_language = "Traditional Chinese"\n'
                                     'project_name = "BMAD"\n'
                                     'document_output_language = "Traditional Chinese"\n'
                                     'output_folder = "_bmad-output"\n'
                                     '\n'
                                     '[modules.bmm]\n'
                                     'user_skill_level = "intermediate"\n'
                                     'planning_artifacts = "{project-root}/_bmad-output/planning-artifacts"\n'
                                     'implementation_artifacts = '
                                     '"{project-root}/_bmad-output/implementation-artifacts"\n'
                                     'project_knowledge = "{project-root}/docs"\n'
                                     '\n'
                                     '[agents.bmad-agent-analyst]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Mary"\n'
                                     'title = "Business Analyst"\n'
                                     'icon = "📊"\n'
                                     'description = "Channels Porter\'s strategic rigor and Minto\'s Pyramid '
                                     'Principle, grounds every finding in verifiable evidence, represents '
                                     'every stakeholder voice. Speaks like a treasure hunter narrating the '
                                     'find: thrilled by every clue, precise once the pattern emerges."\n'
                                     '\n'
                                     '[agents.bmad-agent-pm]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "John"\n'
                                     'title = "Product Manager"\n'
                                     'icon = "📋"\n'
                                     'description = "Drives Jobs-to-be-Done over template filling, user value '
                                     'first, technical feasibility is a constraint not the driver. Speaks like '
                                     'a detective interrogating a cold case: short questions, sharper '
                                     'follow-ups, every \'why?\' tightening the net."\n'
                                     '\n'
                                     '[agents.bmad-agent-ux-designer]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Sally"\n'
                                     'title = "UX Designer"\n'
                                     'icon = "🎨"\n'
                                     'description = "Balances empathy with edge-case rigor, starts simple and '
                                     'evolves through feedback, every decision serves a genuine user need. '
                                     'Speaks like a filmmaker pitching the scene before the code exists, '
                                     'painting user stories that make you feel the problem."\n'
                                     '\n'
                                     '[agents.bmad-agent-architect]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Winston"\n'
                                     'title = "System Architect"\n'
                                     'icon = "🏗️"\n'
                                     'description = "Favors boring technology for stability, developer '
                                     'productivity as architecture, ties every decision to business value. '
                                     'Speaks like a seasoned engineer at the whiteboard: measured, always '
                                     'laying out trade-offs rather than verdicts."\n'
                                     '\n'
                                     '[agents.bmad-agent-dev]\n'
                                     'module = "bmm"\n'
                                     'team = "software-development"\n'
                                     'name = "Amelia"\n'
                                     'title = "Senior Software Engineer"\n'
                                     'icon = "💻"\n'
                                     'description = "Test-first discipline (red, green, refactor), 100% pass '
                                     'before review, no fluff all precision. Speaks like a terminal prompt: '
                                     'exact file paths, AC IDs, and commit-message brevity — every statement '
                                     'citable."\n',
               'bmadFiles': {'_bmad/LICENSE': '0aa79baf6328b4a1e694ce10a12ffc36d7666554da128dff0e8fcda0fc536a66',
                             '_bmad/_config/bmad-help.csv': 'fc9c206d394e72d18a051b0de6eb18e2f1b3abae8f585927496cbf8f7a8ac365',
                             '_bmad/_config/files-manifest.csv': 'a3e609486256b49b4a5f9f3cb24f5545d63ea01ecbd3028bb40a2db75af35d9b',
                             '_bmad/_config/manifest.yaml': 'f35203ac12ca0e15e2c4e3a865bd58d91c142df0730b2f698c58db7f157a24c8',
                             '_bmad/_config/skill-manifest.csv': '6d414dcda3fbfc4c8716ab309dbfa5493c0ce0fee8566cc822918e5c874a2544',
                             '_bmad/bmm/config.yaml': '5c336426099f8fbc17eb406e0a58e459efc87660fb2247b805ad9664ab4f6729',
                             '_bmad/bmm/module-help.csv': 'c3c1033c8fffef924bb71342e22a0a2a8243911a0b856e2aa7804d8bb49feb5a',
                             '_bmad/bmm/v6-shims/README.md': '5495469425b50bca1cd74899c6ebfe840f137cf2a68d008bc993aa2574bd9972',
                             '_bmad/config.toml': 'ee4b98d08da4414c6983c88d4becd17e90d9e30b1dc822f80d742e9b812dbcf3',
                             '_bmad/core/config.yaml': '7186a057f980ef1d07722b17764b01c03907bbabdbdb85ecd52f888f2d58eb0c',
                             '_bmad/core/module-help.csv': '38846d71f87159345d6a6256a170c142fb3f53d9cf9c258c9ee6f26bd88a86c7',
                             '_bmad/core/v6-shims/README.md': '017900bb03baeddc0262041a6aa85bce744e8c45991dcde32ef042f9bc2a32b2',
                             '_bmad/scripts/config_utils.py': '48afe2bc18a29201e343cce3703be1e70df9c83ee74eeb68e57ef8ef42e8c651',
                             '_bmad/scripts/memlog.py': '4916a9c63ec164568cf428ce27b44d6657933f098ee3ae3970b25f0f9d8f9240',
                             '_bmad/scripts/render_skill.py': '8496d0d8b449d64c21b42a9aab3b13fc8a813a430c0695ffd84ad75bb1da7942',
                             '_bmad/scripts/resolve_config.py': '70d7577396ed40ab9462ab75dce51f852bc2e094b2d1a054214f1b30c8789768',
                             '_bmad/scripts/resolve_customization.py': 'c95aab9f2dc500d6ab7db77d6a7860028701ce414e03690613a282cc3659d284'},
               'bmadFilesManifestTemplate': 'type,name,module,path,hash\n'
                                            'yaml,manifest,_config,_config/manifest.yaml,f35203ac12ca0e15e2c4e3a865bd58d91c142df0730b2f698c58db7f157a24c8\n'
                                            'csv,module-help,bmm,bmm/module-help.csv,c3c1033c8fffef924bb71342e22a0a2a8243911a0b856e2aa7804d8bb49feb5a\n'
                                            'md,README,bmm,bmm/v6-shims/README.md,5495469425b50bca1cd74899c6ebfe840f137cf2a68d008bc993aa2574bd9972\n'
                                            'yaml,config,bmm,bmm/config.yaml,5c336426099f8fbc17eb406e0a58e459efc87660fb2247b805ad9664ab4f6729\n'
                                            'toml,config,config.toml,config.toml,ee4b98d08da4414c6983c88d4becd17e90d9e30b1dc822f80d742e9b812dbcf3\n'
                                            'csv,module-help,core,core/module-help.csv,38846d71f87159345d6a6256a170c142fb3f53d9cf9c258c9ee6f26bd88a86c7\n'
                                            'md,README,core,core/v6-shims/README.md,017900bb03baeddc0262041a6aa85bce744e8c45991dcde32ef042f9bc2a32b2\n'
                                            'yaml,config,core,core/config.yaml,7186a057f980ef1d07722b17764b01c03907bbabdbdb85ecd52f888f2d58eb0c\n'
                                            'py,config_utils,scripts,scripts/config_utils.py,48afe2bc18a29201e343cce3703be1e70df9c83ee74eeb68e57ef8ef42e8c651\n'
                                            'py,memlog,scripts,scripts/memlog.py,4916a9c63ec164568cf428ce27b44d6657933f098ee3ae3970b25f0f9d8f9240\n'
                                            'py,render_skill,scripts,scripts/render_skill.py,8496d0d8b449d64c21b42a9aab3b13fc8a813a430c0695ffd84ad75bb1da7942\n'
                                            'py,resolve_config,scripts,scripts/resolve_config.py,70d7577396ed40ab9462ab75dce51f852bc2e094b2d1a054214f1b30c8789768\n'
                                            'py,resolve_customization,scripts,scripts/resolve_customization.py,c95aab9f2dc500d6ab7db77d6a7860028701ce414e03690613a282cc3659d284\n',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'bmad-workflow',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/bmad-advanced-elicitation/SKILL.md': 'd38cb53f1c7c77f13664c340026a1a4932ae1ca5a24471eebaeb172b88c7942f',
                         '.agents/skills/bmad-advanced-elicitation/assets/methods.csv': 'd110ff5f076fb9421552b83692fde2c2d367734049169c7a55f7267a3dc7ef89',
                         '.agents/skills/bmad-advanced-elicitation/customize.toml': '735a276edd51786ccfd2c3417d9a2b9dee4244a6102698981b3888f68d979ed9',
                         '.agents/skills/bmad-advanced-elicitation/scripts/pick_methods.py': '60020ec4767894ea3d8707c4b61e78b679d434315be1dd29154bf64d88126fff',
                         '.agents/skills/bmad-advanced-elicitation/scripts/tests/test_pick_methods.py': '610099d8494529f9203d7262567810b500552bcef006b3b6388d58da3da71978',
                         '.agents/skills/bmad-agent-analyst/SKILL.md': '6bfe0ccc9d85be7c651f9d430f37192abc32c67b5445f037dfea9c87d95ce4f0',
                         '.agents/skills/bmad-agent-analyst/customize.toml': 'd6e2c5c660e8900866298961266a0b1c189c8643f2c1c9da602101e9f98d3388',
                         '.agents/skills/bmad-agent-architect/SKILL.md': '02b2361438d39181f7990940a35af73658d37831572dd5d5ab9cfca17e8f0817',
                         '.agents/skills/bmad-agent-architect/customize.toml': 'bd0ebb48faeab1e6f709d0291a13d33003484a597ed2b9c90f221b2345513b06',
                         '.agents/skills/bmad-agent-dev/SKILL.md': '5e81cd7db67a76626bef308374a06664cd52395b97c15966d09543765257f33d',
                         '.agents/skills/bmad-agent-dev/customize.toml': 'ab52d8840427e10d5956b592c34e63edc77ebdafd7b54ce60da11cf67ed72ced',
                         '.agents/skills/bmad-agent-pm/SKILL.md': 'cd3e8bf36b6e77d4b2d33c5700f0528a6cd2796b24ea22b227301bc60168b083',
                         '.agents/skills/bmad-agent-pm/customize.toml': '4613c72cfe3bc3143bd50c5732bce464c21c7266fe7dd930bc659c54e7315b39',
                         '.agents/skills/bmad-agent-ux-designer/SKILL.md': '3c28653423072119cbf8eb7b6e09a0fb6f1cd7679ee1a27735dea20a2a76c28d',
                         '.agents/skills/bmad-agent-ux-designer/customize.toml': '4acd1d9cdbf4a4328c389229ea9e9f2885d0692f8e10e3d9456da45844337c2c',
                         '.agents/skills/bmad-architecture/SKILL.md': '4a256afa9c725e0bf5b55961d21774f1eb00011dbe31509e280a955bdb1a5c09',
                         '.agents/skills/bmad-architecture/assets/spine-template.md': 'ef4ff795624eb5439fae54a06edb389feb5a0cf79cb01ae007af51109335d198',
                         '.agents/skills/bmad-architecture/customize.toml': 'e9c5f75bd6605199f3908d6a1f013d6b42fb12b6f35c9a5e13a44f7f872b7b79',
                         '.agents/skills/bmad-architecture/references/headless.md': '4db2708f335c94cb024b5eba022b1e3d88b1ec61c94c4716626d9b89684f5833',
                         '.agents/skills/bmad-architecture/references/reviewer-gate.md': 'd32e32a3c1d59b5612b947004f3f6fef1117a13ce9f1ffa428d616e0b5d4db69',
                         '.agents/skills/bmad-architecture/scripts/lint_spine.py': 'dd48be20384adfa281d295e34a39c1ae55727af7e98efe42525be31d1c5c001e',
                         '.agents/skills/bmad-architecture/scripts/tests/test_lint_spine.py': 'e86bb9a62c5cca74ddc89c843386f2b992610fcc1792d40e03bc9cd445b77681',
                         '.agents/skills/bmad-brainstorming/SKILL.md': '2657a2088329651fd06f030e61997fc9f21986588d65ce96f14043af14d8534e',
                         '.agents/skills/bmad-brainstorming/assets/brain-icons.json': 'a101c56e89f1d0f9e4131dfdfc19e10c746e3a61c3f92537d04a6f4897b7d331',
                         '.agents/skills/bmad-brainstorming/assets/brain-methods.csv': 'fff112eabca1a9cb8b190f8314bc47678becc5782a2372e11c83daa0e33b6dfd',
                         '.agents/skills/bmad-brainstorming/assets/brain-selector.html': 'c110919a3366bd96061f050f98503e3586185e3d1df5ff8b62a5a046c571a436',
                         '.agents/skills/bmad-brainstorming/customize.toml': '313c3b348473cd40ba02ceae4b299c617300af78debb2f5585c8d3941cc2d8d3',
                         '.agents/skills/bmad-brainstorming/references/converge.md': '1528c32ddc64f8061fec663306f7208d2fd4d4a90e660552b8138bda7e452dc0',
                         '.agents/skills/bmad-brainstorming/references/finalize.md': 'b6074e7fb4d86ffcf899abc50b9049b4a1f6fe550917f4be7a1c7a888477e07e',
                         '.agents/skills/bmad-brainstorming/references/headless.md': 'b8ea5951199cff7e4813e06aef35683ca0658230fa015e358cacc466b1138a42',
                         '.agents/skills/bmad-brainstorming/references/in-chat-techniques.md': '18239464e3e4f00ea9063d015d26d6b0a696b72e7e3c5be92352da6db9a3f244',
                         '.agents/skills/bmad-brainstorming/references/mode-autonomous.md': 'd815d2c7f0f8cc0cdfa7c619eaf61f59fd78142f13c69365eda257da38b97bdf',
                         '.agents/skills/bmad-brainstorming/references/mode-facilitator.md': '1b908498d285d190859aed00c3ba5b399d7f6aa8e94d54e95456d15cd6fe6073',
                         '.agents/skills/bmad-brainstorming/references/mode-partner.md': 'caa0ed378c116def4de382f4e5a95173c6ae6cc5464f1792e7d8196360f79c8a',
                         '.agents/skills/bmad-brainstorming/references/resume.md': '0f79535d72eefe6c55bd5ae47fe4753de8d27235cf129f10b2c596a124c26526',
                         '.agents/skills/bmad-brainstorming/scripts/brain.py': 'f81b28fe590f607b95c7218a7cdd6fb6eb91d3a76b9671acf54bcaf36fd4e6ca',
                         '.agents/skills/bmad-brainstorming/scripts/tests/test_brain.py': 'b219da8e5e3ccd4ebae95fb02bc5683d6b62593d71db75a712adc7a1b9017bc3',
                         '.agents/skills/bmad-build-auto/SKILL.md': 'ea798a5f7df3b11eb73555a54fc0516c70d8f98739bd7857d968297b26f6ef94',
                         '.agents/skills/bmad-build-auto/compile-epic-context.md': '64d13b41974cfa0dfc1de64b6fbd8365e9b99f91c7c98f0ee1a9fbd018f324ca',
                         '.agents/skills/bmad-build-auto/customize.toml': '31417a8239f213c00621bb9016c3099631ae7ef03731ce5be209a5668a5730ee',
                         '.agents/skills/bmad-build-auto/references/claims-check.md': '50ea17cb89a78ef815286dde2dabfd09f1dc9841d07a10857f88b39ab7b9bd2a',
                         '.agents/skills/bmad-build-auto/references/deletion-check.md': '0f1f124e4e957147e89164a272b10bedc694ad0d9ad2618c8610ac74ee9cb0da',
                         '.agents/skills/bmad-build-auto/review-prompts/edge-case-hunter.md': '8fc046af1cbf4ecc928207cec75e29c3c260adb86cc7da77537ade3b3a3b9448',
                         '.agents/skills/bmad-build-auto/review-prompts/verification-gap.md': '45ab0b8c4c56c5c055c97a293a8591a67e256d0b1a2058ce1f093cd866be8d03',
                         '.agents/skills/bmad-build-auto/spec-template.md': '59a046df2773ec05af0688823d17238bfde2bb54c0c3b3eff6acec4856f1eb7a',
                         '.agents/skills/bmad-build-auto/step-01-clarify-and-route.md': '50674ecef3b4b7a26b993685c9a79ccd87b00b2255d51b6b9c13ed32aa6d1ffa',
                         '.agents/skills/bmad-build-auto/step-02-plan.md': 'a08e303c10f88dbfce88c55044757ec5059afe338793eb414e1ddb0b7c324625',
                         '.agents/skills/bmad-build-auto/step-03-implement.md': '0dc9c9634eca148baaec03e7d154840a14101f92492b7ab469625bf13b4e2ab5',
                         '.agents/skills/bmad-build-auto/step-04-review.md': 'c5530c50c89f197720275b83466b382f896fa27a0bba30d4b75c6af162148cdf',
                         '.agents/skills/bmad-build-auto/workflow.md': '611f429206029a903ec9433ccdfd9b186fbafc6dc95da0a21fbcdf5965ad25ea',
                         '.agents/skills/bmad-build/SKILL.md': '1cdf5406965ba24236d2375739d839699eb56b619834490539d1bd3d5111f890',
                         '.agents/skills/bmad-build/compile-epic-context.md': '6793b15ae85766cee529e6b349e45f2c6ec9e3212019611c29e8c77b4dc4b924',
                         '.agents/skills/bmad-build/customize.toml': '0ee9b033a40640420d1dc3411de7428146d00bf8c1409c9a9cfe6c1743cd53b9',
                         '.agents/skills/bmad-build/references/claims-check.md': '50ea17cb89a78ef815286dde2dabfd09f1dc9841d07a10857f88b39ab7b9bd2a',
                         '.agents/skills/bmad-build/references/deletion-check.md': '0f1f124e4e957147e89164a272b10bedc694ad0d9ad2618c8610ac74ee9cb0da',
                         '.agents/skills/bmad-build/review-prompts/edge-case-hunter.md': '8fc046af1cbf4ecc928207cec75e29c3c260adb86cc7da77537ade3b3a3b9448',
                         '.agents/skills/bmad-build/review-prompts/verification-gap.md': '45ab0b8c4c56c5c055c97a293a8591a67e256d0b1a2058ce1f093cd866be8d03',
                         '.agents/skills/bmad-build/spec-template.md': 'e217325964857ebd90a9508bf171eddc2c4ad1b0b9b32a119775ac5c015695fd',
                         '.agents/skills/bmad-build/step-01-clarify-and-route.md': '1e8095b08e9e9c57d9b24678b524e07d0b6bbb5af72ba213622f12a1c7d909cc',
                         '.agents/skills/bmad-build/step-02-plan.md': '5c999430f818f58fc5e4f64309a1b0f81358ce0ddcfbd3f44b25d56279ef25d8',
                         '.agents/skills/bmad-build/step-03-implement.md': '15fd02d2f655d4102c515134ed6aa40cd055bd9d811e49d529512f8f36d09b03',
                         '.agents/skills/bmad-build/step-04-review.md': 'f6b3f3fa5d3af0b324db2efee9351d4c348bdc0dfa4dad6c058eb4fd37921333',
                         '.agents/skills/bmad-build/step-05-present.md': '551e0847e2ebb64575180a5dacca5786b9b9d7825dcd986e1b3b58442eaf713a',
                         '.agents/skills/bmad-build/step-oneshot.md': '241fa52e227c048a5d8e4428bef0f153267475f697640899deb218b58ebfd378',
                         '.agents/skills/bmad-build/sync-sprint-status.md': '7ff44d21f5d813f4993780271eec8df2fce1373f525ff80e595b7c10618c4c36',
                         '.agents/skills/bmad-build/workflow.md': '481ff00ef349a9c7845feca02bbfd5722b1e318ccabac858355da6c90c2d8a39',
                         '.agents/skills/bmad-code-review/SKILL.md': 'de287a30b672fd3c435f68f644d231091fb788e6d857a3e9f9d1ca22e67e13c1',
                         '.agents/skills/bmad-code-review/customize.toml': '282d9483ccb74acab1efb965ce10ebd6206a61da94da245a705a6358dbf0dc2e',
                         '.agents/skills/bmad-code-review/references/claims-check.md': '7be5d35dd90a1950addc2062acdf8669026b239117efe1e398da1e8161cfa6f9',
                         '.agents/skills/bmad-code-review/references/deletion-check.md': '0f1f124e4e957147e89164a272b10bedc694ad0d9ad2618c8610ac74ee9cb0da',
                         '.agents/skills/bmad-code-review/review-prompts/edge-case-hunter.md': '5f4572d57340b4c0d155f33454d644a44af101cd7fd02a01591be68a4ebb8b7f',
                         '.agents/skills/bmad-code-review/review-prompts/verification-gap.md': '06f6184d7d94c808970d0146cdc4585dfd66b94a7b7ab2988277fb6fc4208508',
                         '.agents/skills/bmad-code-review/steps/step-01-gather-context.md': '51941fd52406cf075ac9172cdcbeebefe85df91ea818ad8ec723724de67a1831',
                         '.agents/skills/bmad-code-review/steps/step-02-review.md': 'f2b8e654cf595746656d9861c4ac722f65b02939c53900f4f6d8b24988b2155a',
                         '.agents/skills/bmad-code-review/steps/step-03-triage.md': '337ac3ad2cd8cabb34f4e47c8778cfd703f919753573dd9d708b7218fd5de684',
                         '.agents/skills/bmad-code-review/steps/step-04-present.md': 'a9619f7df9b9112c0e42ee71a362f73dfa38ef6dff7b403975dbd6d2480a8d9f',
                         '.agents/skills/bmad-correct-course/SKILL.md': '1a56020a13e17f20a420a206ad6d7b09b5f91fe89f6a14918ad77e691bd05686',
                         '.agents/skills/bmad-correct-course/checklist.md': '3e082b95def90ccb876e3101ce0bbaf797a0f03a9471e1347361897f27977327',
                         '.agents/skills/bmad-correct-course/customize.toml': '9990c3d4a1aa90a207f7e3380a7a48a5c9c005702194f63c6a959a4b1a18586f',
                         '.agents/skills/bmad-create-epics-and-stories/SKILL.md': '506d7c2e02a301e012eb75b918c00e6f53ba1dd6295f6e313cc7bf0a77c83261',
                         '.agents/skills/bmad-create-epics-and-stories/customize.toml': 'e7633a4e6e33161c7cb13034e5132d9d29f8a7031e75765d16a60724f2089557',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-01-validate-prerequisites.md': '7181608c1ee4e55c084c6627d68fc55a8a0b6917e489f8ac77531a0530428a30',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-02-design-epics.md': '7c66987808c1f84e853fe54b7aff26d209196d450b5644704110f124a15179bc',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-03-create-stories.md': 'c5b787a82e4e49ed9cd9c028321ee1689f32b8cd69d89eea609b37cd3d481afc',
                         '.agents/skills/bmad-create-epics-and-stories/steps/step-04-final-validation.md': '12b869b4f0531c9cf68a6b7a076409643858de245916ad4c1651e42189c86835',
                         '.agents/skills/bmad-create-epics-and-stories/templates/epics-template.md': '542c4fd17c2382ea36aa3b7b15929f3fd62a8092631c60c83a78629bfc56e368',
                         '.agents/skills/bmad-customize/SKILL.md': 'ef42ffe69d1758ee12f22d6c143262926f715dd13fecb874c8a5971916d41598',
                         '.agents/skills/bmad-customize/scripts/list_customizable_skills.py': '9bfc913e6d23c3553096a68844823b022505f8b2ca7844eccdaf40b1b9288992',
                         '.agents/skills/bmad-customize/scripts/tests/test_list_customizable_skills.py': '24c3d384b3b5d490b7335c17866bfe0425af253ce669c32382fa88feb705934d',
                         '.agents/skills/bmad-deep-recon/SKILL.md': 'e6de27d7c037e2951c5684d976186f6772cc724279af4b3cac05e21c42156db5',
                         '.agents/skills/bmad-deep-recon/assets/research.template.md': '87d7cfa85fa5036b5a309b7bfb88f7934f50bb81f3cff02d2b49b4c7345cfc38',
                         '.agents/skills/bmad-deep-recon/customize.toml': '24d1383066034fd4fcf282279aaf0d29d21910fd1247dfe3dbad74a70e78814d',
                         '.agents/skills/bmad-deep-recon/references/draft.md': 'ac19b33a00ca529c3281df6076f87a833a3b11fc30915ca2c6e7590f7986b90e',
                         '.agents/skills/bmad-deep-recon/references/finalize.md': 'd2ba4bee615dfbca6e7725179fb5ebd856dd34a54ba3f306e25255dfd7b1d126',
                         '.agents/skills/bmad-deep-recon/references/html-briefing.md': 'cd3a88c1a5505fa7f1b715afc3adb34f3d64ade66f4c6b49a59f7e8cfcbe38d4',
                         '.agents/skills/bmad-deep-recon/references/lifecycle.md': '2315fd9cb9223504639616b861ad593bfecb53d605efbd598ae2cf94fb6c4cdf',
                         '.agents/skills/bmad-deep-recon/references/process.md': '9017d04774807a29103ea97331e555e2793f90098af65752b72f3ee09df85906',
                         '.agents/skills/bmad-deep-recon/references/run.md': '8e259dc88820ac989c79620af5c37e24f00df21ac4af308ce3563c0e66c9406c',
                         '.agents/skills/bmad-deep-recon/references/selection.md': '2b488c08f9550afe7fda32c2dc5d4591927afd7b9ad507fcce0ae8593c4b9d31',
                         '.agents/skills/bmad-deep-recon/references/synthesis.md': '4d9ef1247ab45241f919010e94c99699abc0a6e18b5bd68fa93ae54afe59d172',
                         '.agents/skills/bmad-deep-recon/references/verification.md': '0393ded4828fec69a4819d7236827910d641d09c3b61144c0211a9a78776fdd2',
                         '.agents/skills/bmad-deep-recon/scripts/recon_kit.py': '20785a881170b3d54122967041016a3986f4ebab407c979409c4f22c8b1c1d49',
                         '.agents/skills/bmad-deep-recon/scripts/tests/test_recon_kit.py': '1b4ddf482dd2d11a214ee2f821c35d7a8c41905b5d8d9cc69a293304bb8a1665',
                         '.agents/skills/bmad-deep-recon/types/academic-lit.md': '514b0b7b1184cb95363dedeb0c2298a9bf5c430c74146fe2114f31780fadb325',
                         '.agents/skills/bmad-deep-recon/types/competitive.md': '39b53df87d295fdc4388719fcdf31ad2221e64afc136e669207f46d2727a3aec',
                         '.agents/skills/bmad-deep-recon/types/domain.md': '3a34b2e62c3589f8c8d01158357ee9fba32648c9fdfe70035bb3ca971862896b',
                         '.agents/skills/bmad-deep-recon/types/market.md': '81ac04499da441857672e29fcd7169436a7e239e67194288ac0d526ec514cb5e',
                         '.agents/skills/bmad-deep-recon/types/technical.md': '55f71428c70547b89d67ef0c6cdad59caeb0ee21082cd1230c05618ba8d04707',
                         '.agents/skills/bmad-deep-recon/types/user-voice.md': '1831ce46e53e8c68244d28e336c5ef9e53e64f21a00b74a817b9b2924c1e8e72',
                         '.agents/skills/bmad-forge-idea/SKILL.md': 'e44d0008db0c0b30f3fa533e987efe66b2c852530b70fed03f0d4d9cbabe2b4b',
                         '.agents/skills/bmad-forge-idea/customize.toml': '839f57b89c8b04038fa795525f55799ee5c23431b17d429fe668880e78399ef2',
                         '.agents/skills/bmad-forge-idea/scripts/resolve_personas.py': '9273c71595d6317e0a1035b1a632a47a8943379797d0a4db0d2842e5787c31cc',
                         '.agents/skills/bmad-forge-idea/scripts/tests/test_resolve_personas.py': 'f8d040801d53e48c1aec147d1e28c5b279e459f49ea1fd1673dbd7e340022a99',
                         '.agents/skills/bmad-help/SKILL.md': '72573fbbd205cab6119015b7a20951055c7f1f583162674ebed7a68368dc889c',
                         '.agents/skills/bmad-party-mode/SKILL.md': '7bf82a11627595762244c969cdcc836869c935c5aa99a7c5ec5657581c1f4dd0',
                         '.agents/skills/bmad-party-mode/customize.toml': '332aca1a85a681ff38a78850deb552e954d6a7d0b32f8d22caf9b2b2324b4e24',
                         '.agents/skills/bmad-party-mode/references/create-party.md': 'e7fdf66d779e7e08d1cd4fbcbb63b78ba2dd8b1d781af0d0da8bea8c7110176b',
                         '.agents/skills/bmad-party-mode/references/mode-agent-team.md': 'def759a17f4bb45463b68fb74c2b828b0a4241720b2b6cc1c9c611a1016ae9d7',
                         '.agents/skills/bmad-party-mode/references/mode-auto.md': 'a37fd24f76dfcde385890d5c5947bb6f40ca44bea86c805d267b6ae3aab39f70',
                         '.agents/skills/bmad-party-mode/references/mode-subagent.md': '86161b24a0b13b8f9cb9309042e4249d8caefff8cc33728b084cd2ec22f9d2e1',
                         '.agents/skills/bmad-party-mode/references/party-memory.md': '800b4b4b920bb881a7b32aaabca8559a98273799b2476d83a23e290e301fb315',
                         '.agents/skills/bmad-party-mode/scripts/resolve_party.py': '810d7838ddb4623c60e29639a3b2484ae140ebc59147acf98bfb934b55577a58',
                         '.agents/skills/bmad-party-mode/scripts/tests/test_resolve_party.py': 'e2a7b1bbbe011b56a917dc54449fa29fb3df8716674a5998a32a50e3b5ee60e7',
                         '.agents/skills/bmad-prd/SKILL.md': 'eafebb3fbebc4e276a055ca9916e20e36e95dca03f819eeeaaf80a3a9c16f07b',
                         '.agents/skills/bmad-prd/assets/headless-schemas.md': '8d3621333a72400512bd62511bc4c73fc745711505e1f852c697ff8c5fa2de93',
                         '.agents/skills/bmad-prd/assets/prd-template.md': 'b6fe8fc1390b8e46961d5eb5e6f2fe6c65dca2f30623d492677672e02868f7ab',
                         '.agents/skills/bmad-prd/assets/prd-validation-checklist.md': '41d9f09064772a92ec908d970618e47ba63dc86b5c5a1a21d5a2c676d3ba8e3f',
                         '.agents/skills/bmad-prd/assets/validation-report-template.html': 'a80becdd8205d2d7c18738855830b096172a496b96b5ca8a0820ec55c9bb8bf9',
                         '.agents/skills/bmad-prd/customize.toml': 'd23707fe7ff5f5060a05b5b8bda3f170b9b1d9be61e409e9f7ae91f83572db6a',
                         '.agents/skills/bmad-prd/references/headless.md': '4dad58ebee63933a53179016513ff94d143ce9f68e226489d390e2c36bf1d848',
                         '.agents/skills/bmad-prd/references/validate.md': '19b2fa66d58cb4fef3d920cd09c81f8add4ee44dd4191bec87eaba84c2093338',
                         '.agents/skills/bmad-prfaq/SKILL.md': 'e16d295601af1ebdf94e2f6da2c5ef3235029997bd78d0cbdab592e3d839dde7',
                         '.agents/skills/bmad-prfaq/agents/artifact-analyzer.md': '7bdc44830f8d593346ec0ee15e36e1e431432fcc6c38b70bb861999315c9cfa4',
                         '.agents/skills/bmad-prfaq/agents/web-researcher.md': '6e9127bb9bd3e4b15c701e4ced9eef328769262cd34eadc221bebe954c1f3aef',
                         '.agents/skills/bmad-prfaq/assets/prfaq-template.md': 'b27e6964f0437ab4e78c8c0ffbe5052c28e3b3ef2fc811726cbb394d5a5c7559',
                         '.agents/skills/bmad-prfaq/bmad-manifest.json': 'b67b016cd68535a97bd9164c237fbfe19a5b26bc1a3f0afe203fecfa40aab6ff',
                         '.agents/skills/bmad-prfaq/customize.toml': 'b764b9ea360734d681115b958d0ccd478f1b56ce0045ecd6f71311ef005d8980',
                         '.agents/skills/bmad-prfaq/references/customer-faq.md': '96f8565197649c58908a1d61b6cd805fd01f57da7945ba889c18d087ad597aeb',
                         '.agents/skills/bmad-prfaq/references/internal-faq.md': '26eb83f844cda1ed8efb50f4703d61713ada8a64bd27eb387f759f858b5748de',
                         '.agents/skills/bmad-prfaq/references/press-release.md': 'c406adb0e2d2cc326cbc45d0174f89d014523448ad82bc272293999d22aec596',
                         '.agents/skills/bmad-prfaq/references/verdict.md': 'c962ce2c97e824cb53dae70c898153ffac3ea56b56565012ca2b96bb21c9618c',
                         '.agents/skills/bmad-product-brief/SKILL.md': '88618d280e90cdfdf8ece62f0e9e6406e3db2d93b70aad66806d1be4bdfa3dbd',
                         '.agents/skills/bmad-product-brief/assets/brief-template.md': 'bb28edf75d023067551c8d417b19b8803324e7acfb2ad0c80f882e9134f4c1f1',
                         '.agents/skills/bmad-product-brief/customize.toml': 'bef95b0ab71793d214ec59ed7397a25f7253e63fad5d60570248614db6186905',
                         '.agents/skills/bmad-project-context/SKILL.md': '50b0ee0f4905273dd7f8a57a4e79b2ff47eabb074b6f4bce8242b950b37dfb63',
                         '.agents/skills/bmad-project-context/customize.toml': '9bf8a3aa919832cd8932853da550fcaebd06a9e13c0cde453f4379d8327f9c0f',
                         '.agents/skills/bmad-project-context/references/best-practices.md': '850c45d2e1de44b1cd8e3b06b8175df53aac8983326d73351eab547bfacc532b',
                         '.agents/skills/bmad-project-context/references/template.md': '5e2bc291e734a481fd2925877adfbe82b03313f300baf67dfdb6fa22a1181601',
                         '.agents/skills/bmad-qa-generate-e2e-tests/SKILL.md': 'f8f6a62c390f0cf7fc88ea04fa1bc236dedde27cdc1ce95cdb6ebc1cd8f33251',
                         '.agents/skills/bmad-qa-generate-e2e-tests/checklist.md': 'b58f810aeb1040c2f6758c88aa133afce72f8cc178d3d97ff0fbaa3d943057dc',
                         '.agents/skills/bmad-qa-generate-e2e-tests/customize.toml': '4fbbd9d96e5af24ae012d33e59582b88867e8203dcd5a29f0d46b42ef6d747b8',
                         '.agents/skills/bmad-retrospective/SKILL.md': 'd3f12423a0e456a7c2a25d5aa005df4eb4cb8c0b5cd400755b026c3c100b99dd',
                         '.agents/skills/bmad-retrospective/customize.toml': '33ce7da5bad6dfe1791218d8d607b749f9b58586b232df7ea0d3263ec50ec466',
                         '.agents/skills/bmad-retrospective/references/acceptance-verdict.md': '09a65007c39af83e01e039331c252e6e670b134cd5e2a4b5e05ac9d9fb7e37f1',
                         '.agents/skills/bmad-retrospective/references/aggregate-views.md': '5b278afce4a53692d8715b4af178e4233da0876921dc3154b5763d056cb5ff0b',
                         '.agents/skills/bmad-retrospective/references/evidence-gathering.md': '575bace78d7c03c48d86a209dd664f7dd22295a222b75e6d6298894cb7b7ce00',
                         '.agents/skills/bmad-retrospective/references/retro-document.md': 'de8164664cd2be7f73b8ba5552e9e0f58816d2a7c4be8efc7715461846bb7001',
                         '.agents/skills/bmad-retrospective/references/team-discussion.md': 'a9c504c436038c7e47d08322413aa3c213d2859b36ae30e873cb8c60fd9e008e',
                         '.agents/skills/bmad-retrospective/scripts/git_evidence.py': '2acbb8b5804d0680b5939629a0c3786a72cde30f5f2cecd75858325c6e778d89',
                         '.agents/skills/bmad-retrospective/scripts/sprint_status.py': '7c9f0a514a6e0834182f3c30485de49e0a4decb9be51027cc8be58aecdb9fc44',
                         '.agents/skills/bmad-retrospective/scripts/tests/fixtures/sprint-status-template.yaml': '64b1a937e1fe03b8b8d158e3b1caeb89e7d51692a56c16038e2af091decc553a',
                         '.agents/skills/bmad-retrospective/scripts/tests/test_git_evidence.py': '0abfc8fad338830fc2db656d3ccc500631b0ea7a2ab87d853c13a6bbd46ff13c',
                         '.agents/skills/bmad-retrospective/scripts/tests/test_sprint_status.py': '23da16cca54904a256fcf88fd8f912c3f6091ea343768c241bbd2aeebbca2af3',
                         '.agents/skills/bmad-review/SKILL.md': 'c571dd7d3aa75f3b40749cf9db352c5e76244de22139cfb13c26629d28be1fa7',
                         '.agents/skills/bmad-review/customize.toml': '005dde84f09c0b1ab0ef0ee87f1ed1985922c893089cc3595157611fb83b3ebd',
                         '.agents/skills/bmad-review/references/editorial-common.md': 'f0cdc72ea345b2c5dc3001477b3dfcc909ca11b78f7db8865b6763d18ffc66c8',
                         '.agents/skills/bmad-review/references/lens-adversarial.md': '7c5ce97ab2f3ecb96ceb6aa76417f68c1b7df535edd3cc51666d8e1216e6e557',
                         '.agents/skills/bmad-review/references/lens-edge-case-hunter.md': '5f0c4778d7b393d11156af8c1bd9bf88aafeb9d50fff5f460ca67df50d927e7d',
                         '.agents/skills/bmad-review/references/lens-prose.md': '4cbcb1eaea8567d272f5db7c6cdfd74ed5a8aae6831053cb2f01cbfc2cb98b98',
                         '.agents/skills/bmad-review/references/lens-structure.md': '98c08221f517133e57ef6325013935360c3365ebd7dcb8411b2050d7df507ee3',
                         '.agents/skills/bmad-review/references/lens-verification-gap.md': 'e7123d81171eeeee1b3782d13d94c2988969fe357dd71949131a5eb97803e2c6',
                         '.agents/skills/bmad-review/references/structure-models.md': 'f84f85070e1af75f2482757aba9d37d69d805a20826d185527e598f2ba6b9292',
                         '.agents/skills/bmad-review/scripts/tests/test_word_metrics.py': '3b5a285d3c9f611b3cda8c9c1d52d6b214c1f72e6e64a94ea5b0e220db5a8765',
                         '.agents/skills/bmad-review/scripts/word_metrics.py': 'fb45007a7f3cfc18d13ee8bd4787facdaae297570193bc769456297dd33da78b',
                         '.agents/skills/bmad-spec/SKILL.md': '46a2c3d5541d63af1520fac6b7abfff161a94b52fed51df6454115e3da5639c7',
                         '.agents/skills/bmad-spec/assets/headless-schemas.md': '83afb3614716db2347d83586a67b9c524492dd50db5282436ccb35c99fb5f08a',
                         '.agents/skills/bmad-spec/assets/spec-template.md': '4b3a032c045fdd0903933446fc07f93e879997f28a0294ed4344da71192b20ee',
                         '.agents/skills/bmad-spec/assets/stories-schema.md': '4f8137c00e2710288354a4466d1cfb90704f4b2a04bd3b63924218fd589cc6a9',
                         '.agents/skills/bmad-spec/customize.toml': 'd0f1f926bed79d514f8fdbc458a1883167fb64663bf2464c40e3c50dc2dcdbea',
                         '.agents/skills/bmad-sprint-planning/SKILL.md': '391fdc181c605ec9da99028f9a82776410c86b50d2cc273b2b8d3d4b266a2012',
                         '.agents/skills/bmad-sprint-planning/customize.toml': '54c7f6a8af77ff7ea6c9dbb00b515023999e011aabc802b7b328e82f505b0299',
                         '.agents/skills/bmad-sprint-planning/references/fix-sprint-status.md': '0406c31b70da33e2a354d9785f43d8f9918f4b923d0aac2ebd1e3707ebad5806',
                         '.agents/skills/bmad-sprint-planning/references/generate-tracking.md': '4dbf7aca26d0e6e893f288fc5e6158dbbcd65f77bbaf95e941ca705abceb1741',
                         '.agents/skills/bmad-sprint-planning/references/readiness-gate.md': '7d58ea61fafe3c1d8218203abc7512e322ca384c78d9e71829df55dfabe1245b',
                         '.agents/skills/bmad-sprint-planning/references/status-view.md': 'c3547e221ebf6e55c874e2ada3e8c18198835213c76f0bb2e0e64150aac355ab',
                         '.agents/skills/bmad-sprint-planning/references/validate.md': 'ac680fa0a0f945a9bc0fc89ca709b2a8e6bc3b2617cd0d3d730378c4b5edd86d',
                         '.agents/skills/bmad-sprint-planning/scripts/sprint_plan.py': 'c4e4daf4200f233501a069a43db56d097c5d4e71f74cd29f132f88b83c2fc95f',
                         '.agents/skills/bmad-sprint-planning/scripts/tests/test_sprint_plan.py': 'f1c3b640e156946b0a234e233807b2a3983cb0d3f2d13dbb9830fbe0c67e5238',
                         '.agents/skills/bmad-sprint-planning/sprint-status-template.yaml': '64b1a937e1fe03b8b8d158e3b1caeb89e7d51692a56c16038e2af091decc553a',
                         '.agents/skills/bmad-ux/SKILL.md': 'b437d6ad812577e31cb6845c2417aa491c2f3a17487aa43ed7960b3b9299b564',
                         '.agents/skills/bmad-ux/assets/color-themes.md': 'ccb6e4ef47a196476cf9392d788938ad3ca8d07b9ce095b7c092dcb4e06735f0',
                         '.agents/skills/bmad-ux/assets/design-directions.md': 'eab73b948da76a27abc908e1e7d6b124e8ff0362e6dd1990f7e60b9541cbcb98',
                         '.agents/skills/bmad-ux/assets/design-example-editorial.md': 'a659166845b1a4ed3f9aef942c5935537a97382b10303684fbb78ed86265870e',
                         '.agents/skills/bmad-ux/assets/design-example-mobile.md': 'a93fb9f114f2e83af0c961c0d7909b3859fc80bcd713715517cd639a53a0372a',
                         '.agents/skills/bmad-ux/assets/design-example-shadcn.md': '25e0dfb2bb21483973a8f0a6ed650288b3dc2ae5ed02aa0f091bb9b6b0b39fc0',
                         '.agents/skills/bmad-ux/assets/excalidraw-wireframe.md': '660bbcdebff50cd044a3752eda43f3cb303aca4b0f521b55a270da93b89ddb18',
                         '.agents/skills/bmad-ux/assets/experience-example-mobile.md': 'f8cd54c92193cd8c34a472df9c212ac7330976f6a115b729721dcb60034dc4f0',
                         '.agents/skills/bmad-ux/assets/experience-example-shadcn.md': 'd6ca16e87b768e8b41f352c02ee08af21d7cdac04ca21e6ae1556864b4d27590',
                         '.agents/skills/bmad-ux/assets/headless-schemas.md': 'e3a773dde85286f1a6f6dd8b26fc17e09ccea96f6257dfe7fb436353cd79242d',
                         '.agents/skills/bmad-ux/assets/key-screens.md': 'ff1c5060673dd595edd61e76806bae876264ec6895c2eaadf8a6190785bf5f7b',
                         '.agents/skills/bmad-ux/assets/validation-report-template.html': '8656945636fabe96624f8ef8fce931b073b5aecbe42d490584c1d5c7f31e1353',
                         '.agents/skills/bmad-ux/customize.toml': 'e85144ed214dc1e002ee7fc6589a0a7ef352c5f79ab4cb37a4e05ee8e245549c',
                         '.agents/skills/bmad-ux/references/creative-tools.md': 'e281292d7c0fdecdbb67ca9b7d95d4bed803626ba5edfd8dcc99146fcaa118e6',
                         '.agents/skills/bmad-ux/references/design-md-spec.md': 'd04d5f663607aba3f3181e818ae33856e6caf5e560dcb16fa64ed80b7cf3d590',
                         '.agents/skills/bmad-ux/references/headless.md': '8da7e23d269b1644f45b5104a243a6a27fd8d075aebb95d9b7752f0d143f0f5d',
                         '.agents/skills/bmad-ux/references/validate.md': '7c2189d9ac1585d9408b6ed0346ba564869e7db89dba8f81044db3431cfcee65',
                         '.agents/skills/bmad-walkthrough/SKILL.md': '2294849558370f1219e5fa7306b731b30aedb0e6649eeeac95d88bff1301d938',
                         '.agents/skills/bmad-walkthrough/customize.toml': '2a4b14c5b25729a2d8fa9d9762ab3f12ac9429cfc6bd31fd80a81d86eed98630',
                         '.agents/skills/bmad-walkthrough/generate-trail.md': '4a5936d86fbe5a85285b4535097b1e2edda8849da35586f4b588a982d7224459',
                         '.agents/skills/bmad-walkthrough/step-01-orientation.md': 'd9e3b949c36d49a025f3535773af2b51888fe4ce616b6d6d69683a122716b1d2',
                         '.agents/skills/bmad-walkthrough/step-02-walkthrough.md': '66cf893f8f968ee81034e9ccd8c20415692c3a8c23a9a143c2245fe6c800acdc',
                         '.agents/skills/bmad-walkthrough/step-03-detail-pass.md': 'd48163b9f305f15af57729a8443142e47beb6c3e977554afe12b39ee49cb9fc0',
                         '.agents/skills/bmad-walkthrough/step-04-testing.md': '28a56e868968ea2d18add0df8c4bccced0f94b698e218df3d45ddac072ce369c',
                         '.agents/skills/bmad-walkthrough/step-05-wrapup.md': '5bfe0f9240ae073f1b5c843d172c11e76cbe6067e8df414ea6a338c81f113f5d',
                         '.agents/skills/merge-reviewer/SKILL.md': '053160628d0ebafb6232ee157fa5b997f4e7a0fcc57b350a5ba751f453971fd8',
                         '.agents/skills/merge-reviewer/VERSION': '065582655aacd6fc83ff742a5715c04bb4a57395bf3ee4559798fa42c2ce4589',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'ae227e5e75073a0026b71673035d78c353864bd2e7ca02cb70274ecec50b3fd6',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '9f73cf2e4612cc5bea51e91e4e32dfb9cd857c532ffaa01d85a9aa026fa3741d',
                         '.agents/skills/merge-reviewer/references/usage.md': 'f2d216cca6bf11e70629166ef59b8967633429716720c7decffa356c85d4107b',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'f89ff4cf4d9d037f57f17af850061fcb30d7a804a995473f1f3669a6f9a9d92a',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'fa23f7f1ef90f218435894075e7fdf5a5c332341911ea917d19b2c05c2394a47',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'c117d7fd6f5dba50da998da576775d2c72e19324cf15c46a5f426f2fcf0dfc76',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'ba48f6f210b5157c2a59e6d949365764c665c0d2438d80803acb8d60b3ee56ec',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '3c2e323ecf4d3b8274974b18ad82a33e2c25fac227697c66fd0470aabde65c46',
                         '.agents/skills/release-reviewer/VERSION': 'f62184cee8787f2f6941c82041a5725d4edc9aa293ebe5dbf664406e82ec1fe1',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': 'ba14f8c8eb4c2d89a909d69cacd9a058a18ed2f6a6b3e0b4067d47587c7926c3',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '355d5b2d780d84bb941db7dc24274750a4989ed450f7ca9fa3403d322a0ed723',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '044dcf261c85c3f733b5674c12b8859158abe0dd7b89f8d9c5603cebc1953bc2',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'aec585e105a0446d485ee1a0153ef1a8ed37455106b726053a96b5c6a11019f6',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
               'overlays': {},
               'payloadSha256': '5ea71a0efe40bf246ea696c739ca09e6a4779922d386ce1177ebb5f4de6c5a46',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': 'f01c5b160e9080d5a65c35309da00d46bb0597ed89cc89eb748d253ae643d2da',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': 'cfe7b1d261c5ec747771848fd91f51dbcaa3351397954cae78f596715b2de1e0'},
               'skills': ['bmad-advanced-elicitation',
                          'bmad-agent-analyst',
                          'bmad-agent-architect',
                          'bmad-agent-dev',
                          'bmad-agent-pm',
                          'bmad-agent-ux-designer',
                          'bmad-architecture',
                          'bmad-brainstorming',
                          'bmad-build',
                          'bmad-build-auto',
                          'bmad-code-review',
                          'bmad-correct-course',
                          'bmad-create-epics-and-stories',
                          'bmad-customize',
                          'bmad-deep-recon',
                          'bmad-forge-idea',
                          'bmad-help',
                          'bmad-party-mode',
                          'bmad-prd',
                          'bmad-prfaq',
                          'bmad-product-brief',
                          'bmad-project-context',
                          'bmad-qa-generate-e2e-tests',
                          'bmad-retrospective',
                          'bmad-review',
                          'bmad-spec',
                          'bmad-sprint-planning',
                          'bmad-ux',
                          'bmad-walkthrough',
                          'codebase-wiki',
                          'merge-reviewer',
                          'output-style',
                          'release-reviewer'],
               'upstream': {'bmad-method': {'asset': 'bmad-method-6.12.4-codex.zip',
                                            'repository': 'bmad-code-org/BMAD-METHOD',
                                            'sha256': '3a9172ced5a3d0f4b41774d2477d0178476bbc822b0148784e75c69ec86bd819',
                                            'version': '6.12.4'},
                            'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '611b9727d723dec1d231654693b098f1b4454a20c893d3fd6f88f6f7b0d65aab',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.14.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '12896a08c49ce5c4aeacf0354fa125084b03bc7ee564156c660a671badf11cd3',
                                               'version': '0.14.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.4.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '3ffc3bada0bd961cc5a7681e0e7ffd6743abfb6d3032198561caba2d5bdd7f39',
                                                 'version': '0.4.1'}},
               'version': '0.26.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '126efd52f34f73aaa7cd3eb0b790b7896d37aafc9773ce1f962e6423d2106668',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '053160628d0ebafb6232ee157fa5b997f4e7a0fcc57b350a5ba751f453971fd8',
                         '.agents/skills/merge-reviewer/VERSION': '065582655aacd6fc83ff742a5715c04bb4a57395bf3ee4559798fa42c2ce4589',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'ae227e5e75073a0026b71673035d78c353864bd2e7ca02cb70274ecec50b3fd6',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '9f73cf2e4612cc5bea51e91e4e32dfb9cd857c532ffaa01d85a9aa026fa3741d',
                         '.agents/skills/merge-reviewer/references/usage.md': 'f2d216cca6bf11e70629166ef59b8967633429716720c7decffa356c85d4107b',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'f89ff4cf4d9d037f57f17af850061fcb30d7a804a995473f1f3669a6f9a9d92a',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'fa23f7f1ef90f218435894075e7fdf5a5c332341911ea917d19b2c05c2394a47',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'c117d7fd6f5dba50da998da576775d2c72e19324cf15c46a5f426f2fcf0dfc76',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'ba48f6f210b5157c2a59e6d949365764c665c0d2438d80803acb8d60b3ee56ec',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '3c2e323ecf4d3b8274974b18ad82a33e2c25fac227697c66fd0470aabde65c46',
                         '.agents/skills/release-reviewer/VERSION': 'f62184cee8787f2f6941c82041a5725d4edc9aa293ebe5dbf664406e82ec1fe1',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': 'ba14f8c8eb4c2d89a909d69cacd9a058a18ed2f6a6b3e0b4067d47587c7926c3',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '355d5b2d780d84bb941db7dc24274750a4989ed450f7ca9fa3403d322a0ed723',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '044dcf261c85c3f733b5674c12b8859158abe0dd7b89f8d9c5603cebc1953bc2',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'aec585e105a0446d485ee1a0153ef1a8ed37455106b726053a96b5c6a11019f6',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
                                                                                                     'upstream_sha256': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4'}}}},
               'payloadSha256': '8b655ef4dd764fe498f6035bd9cb0a11b6da67052388f9b93a36db36d7955a19',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'ddd2353b6c2a12a07f225332ca3b31e99126f12d4ddc9013f8f031b4077b12a9',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': 'a8acee6ad458be73c83d1a76472fc231a8f44eed1aea71774b792982370bf71b'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'ef96009302e563a368f92961e2855037ebdd72058486d15836163a8e5d3de7b5',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.14.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '5eefd22d684666ef83061d13bd3540e0416a785ddaba0d8722c0f9ceceec860f',
                                               'version': '0.14.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.4.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '30bf13b5102794bb22e5b8f58356deb2525050b12c861da99764d1bc8b69e53e',
                                                 'version': '0.4.1'}},
               'version': '0.27.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '3a8923db0a1e65f6102abe8fa528441cc41eccfee06d22797b9ff50122c5d1e8',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '053160628d0ebafb6232ee157fa5b997f4e7a0fcc57b350a5ba751f453971fd8',
                         '.agents/skills/merge-reviewer/VERSION': '065582655aacd6fc83ff742a5715c04bb4a57395bf3ee4559798fa42c2ce4589',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'ecc4ca6b80baec31b883ba5050ba5ab84c217c3fc4891989077f51be671aa377',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': 'ae227e5e75073a0026b71673035d78c353864bd2e7ca02cb70274ecec50b3fd6',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '9f73cf2e4612cc5bea51e91e4e32dfb9cd857c532ffaa01d85a9aa026fa3741d',
                         '.agents/skills/merge-reviewer/references/usage.md': 'f2d216cca6bf11e70629166ef59b8967633429716720c7decffa356c85d4107b',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'f89ff4cf4d9d037f57f17af850061fcb30d7a804a995473f1f3669a6f9a9d92a',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'fa23f7f1ef90f218435894075e7fdf5a5c332341911ea917d19b2c05c2394a47',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'c117d7fd6f5dba50da998da576775d2c72e19324cf15c46a5f426f2fcf0dfc76',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'ba48f6f210b5157c2a59e6d949365764c665c0d2438d80803acb8d60b3ee56ec',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '3c2e323ecf4d3b8274974b18ad82a33e2c25fac227697c66fd0470aabde65c46',
                         '.agents/skills/release-reviewer/VERSION': 'f62184cee8787f2f6941c82041a5725d4edc9aa293ebe5dbf664406e82ec1fe1',
                         '.agents/skills/release-reviewer/agents/openai.yaml': 'de2c4735d8a4fc9738b0a0b1d7ddedf41aa9bb6cb4e3fa52becd0aab59d83a9f',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': 'ba14f8c8eb4c2d89a909d69cacd9a058a18ed2f6a6b3e0b4067d47587c7926c3',
                         '.agents/skills/release-reviewer/references/group-review.md': '86ea04230413fb5ea9f81111cbae95365e29d2923cde392aa7afb315f09fbabf',
                         '.agents/skills/release-reviewer/references/report-style.md': '355d5b2d780d84bb941db7dc24274750a4989ed450f7ca9fa3403d322a0ed723',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'eed50ec34238691a4683bec3c9f5e024e7ecc0b84f3e907f5e516b7e0a436a26',
                         '.agents/skills/release-reviewer/references/review-examples.md': '2e9a5ac12f53e78bcf6eb4972aaa8574e142a54dc296f6efcd1b03cf90399194',
                         '.agents/skills/release-reviewer/references/review-rules.md': 'a3cf705c5989edc2e70acdd7e67b46fb861d35634fdfb4c19bcacc2a6c2fedcb',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '7c71a2eefa5c768d439154f76c46d10f3142ea96b6dd9766cfb2e57c592ce164',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '044dcf261c85c3f733b5674c12b8859158abe0dd7b89f8d9c5603cebc1953bc2',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'c4ee2256d207ba4cc69196e4a97108e2e55e4f4b205acdc34d0f82f4bfc26113',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '6945e1616bb98770380e590b8d007fd20a1aaff816a4170845d1ce70acad01ce',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '71724dee5341f2f5b986a7b14e67ac4a9c8730277e52c90a2589d3dff007daa9',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'aec585e105a0446d485ee1a0153ef1a8ed37455106b726053a96b5c6a11019f6',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '504a9d454bbb1f001552f1a536fad4643ec9309a70878ba3f37eddd5d60dc2d5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '720d0447b70b549f2e158b94368d750bcf8e0adde2df0845cb6819e08d9054d5'},
               'overlays': {},
               'payloadSha256': '2b924d5af10f2a07a61b8ef5df9496b6a878ded0a815a84a39d32462666e8d64',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '57c2dac61e73ffaef02a7de131a427d62d835522c9ff9eadeaa5c999df56ea5c',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '92922d3a8e3aff039295303b0b5b841811d6a8e43ba8fd10055907677350dfa8'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'ef96009302e563a368f92961e2855037ebdd72058486d15836163a8e5d3de7b5',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.14.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '5eefd22d684666ef83061d13bd3540e0416a785ddaba0d8722c0f9ceceec860f',
                                               'version': '0.14.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.4.1.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '30bf13b5102794bb22e5b8f58356deb2525050b12c861da99764d1bc8b69e53e',
                                                 'version': '0.4.1'}},
               'version': '0.27.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '508e70cc5b9a47b4313aef2324a5d35dcd2057303aab9535a98ca42b15b5959a',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '7e37651dcacfdccca38da89a2f0f933f2d2be2bf708602ae0c16767e2581af9a',
                         '.agents/skills/merge-reviewer/VERSION': 'f8405a7330c287028d470c3ee3506f878f1ad85ed79c1d1adc19df2ff7398915',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '3b8849c1476f9acdfa53fd6188bc1c8bffedf5157e0cb22377d9fd0b76b93680',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '68b4450250acd8dc2b9f8cb733878253be3959ba9fe14faa9f0c577280595d5d',
                         '.agents/skills/merge-reviewer/references/usage.md': '437acf9e4e7de1150db66a121dbb3b3b606d737e8f35dbd2d8f631b90d2a957d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '47aaf0b8b9a403db0fad256b436e9ee4ee42007f05170928660d2294595192ae',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '4d14ac814b975553170b773f02ad9ca73a512682b2574dd90e8290fba1aa2489',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '803faaf024e4d36c0f4cc2e5f04f052ce21e21e70f19b9b9a0b45a5cd9638644',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '7a6b4505bd2d3df8222a4527fa236b05b320f7fcf2a4c2efee5479d2597f91c7',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '53d82266d1126508fafdb8bab3c9298d0226edadf68b4cdad09e3fcf26da73b4',
                         '.agents/skills/release-reviewer/VERSION': 'a0ad50640139a524f86591157145bf1d4674ea9c065bfea21558f0f7b04430c8',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '3ef5d55b58469e2c7287200a3b1664f688dbe6c16b0970533a2fd8c3bac94d1e',
                         '.agents/skills/release-reviewer/references/group-review.md': '81abfbfc1c7bf01fd653afe62ed1fb1a7b49ad2f4c9c00f564a4834c79bd62f6',
                         '.agents/skills/release-reviewer/references/report-style.md': '1936b53c109bab53d94ca739612f6cf01b1ab49c44200758bc6bb58a5b3ca8e6',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'f4fbfc946d15dd2cfd74ff9916d278123f50943256a634b5d6878ed4bdf75e76',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '712d19533cc2400c33d4744fabf6193d85ed3dfdfae4170835fa28af560904e1',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': 'be5f9d5cfc7680e355a30d01eb55209377e15c0732ad6a5298c035cab72e0d4f',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '022b3f99d429221a619f1674cd44ead1fc1c12a883e974d141f9b730c3a1b2a4',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '7bc0129e134c55613073338b75d9ad57557ea686c7959fb7cd7988bc3000a8bc',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'a991c2f1da9dd961f38b482c492e7aac8ec54167384e675e11c230ae9fc2085b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'fb90e24e898c3a70dc241ed60f7b1002ed3e04d5601a66df4aeb0dd4b5bbfd68',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '79859aa293f10aa6e52484eb1ad88b0243e6ed1eab113631d310ef1eaedc933c',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '0958ba7b92b152c9d8f69543b4d3c94882c4dc22de19546d8e4d4f71046495ea'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
                                                                                                     'upstream_sha256': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4'}}}},
               'payloadSha256': 'f5d9dff74848b1bce03e38ad2e796b68e3a3dcfe4a98f811e628daa9e71c4eb0',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'a0ebfc46c673b7419077be14c66439740bf7972dde9774cc25148274f0202d3c',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '97e555f6d23d41fd03fc5d1ac4ea60b472c35b5afad36044124a6c1113b566e1'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'ef96009302e563a368f92961e2855037ebdd72058486d15836163a8e5d3de7b5',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.15.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '72567f0c7354dd5bd4c7e7d2582a0dc058936660f34104dafec3c442c266ebe7',
                                               'version': '0.15.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.5.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'e0b4f9f50cb2445ebbf53c8d0ddee5c353c05ba0d155fb5f0f4909d0a3023222',
                                                 'version': '0.5.0'}},
               'version': '0.28.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '8028970f1f55213bf4e4c4a81aaedb793864304f35d690341c9a42cf0ebb20ee',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '7e37651dcacfdccca38da89a2f0f933f2d2be2bf708602ae0c16767e2581af9a',
                         '.agents/skills/merge-reviewer/VERSION': 'f8405a7330c287028d470c3ee3506f878f1ad85ed79c1d1adc19df2ff7398915',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '3b8849c1476f9acdfa53fd6188bc1c8bffedf5157e0cb22377d9fd0b76b93680',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '68b4450250acd8dc2b9f8cb733878253be3959ba9fe14faa9f0c577280595d5d',
                         '.agents/skills/merge-reviewer/references/usage.md': '437acf9e4e7de1150db66a121dbb3b3b606d737e8f35dbd2d8f631b90d2a957d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '47aaf0b8b9a403db0fad256b436e9ee4ee42007f05170928660d2294595192ae',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '4d14ac814b975553170b773f02ad9ca73a512682b2574dd90e8290fba1aa2489',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '803faaf024e4d36c0f4cc2e5f04f052ce21e21e70f19b9b9a0b45a5cd9638644',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '7a6b4505bd2d3df8222a4527fa236b05b320f7fcf2a4c2efee5479d2597f91c7',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '53d82266d1126508fafdb8bab3c9298d0226edadf68b4cdad09e3fcf26da73b4',
                         '.agents/skills/release-reviewer/VERSION': 'a0ad50640139a524f86591157145bf1d4674ea9c065bfea21558f0f7b04430c8',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '3ef5d55b58469e2c7287200a3b1664f688dbe6c16b0970533a2fd8c3bac94d1e',
                         '.agents/skills/release-reviewer/references/group-review.md': '81abfbfc1c7bf01fd653afe62ed1fb1a7b49ad2f4c9c00f564a4834c79bd62f6',
                         '.agents/skills/release-reviewer/references/report-style.md': '1936b53c109bab53d94ca739612f6cf01b1ab49c44200758bc6bb58a5b3ca8e6',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'f4fbfc946d15dd2cfd74ff9916d278123f50943256a634b5d6878ed4bdf75e76',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '712d19533cc2400c33d4744fabf6193d85ed3dfdfae4170835fa28af560904e1',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': 'be5f9d5cfc7680e355a30d01eb55209377e15c0732ad6a5298c035cab72e0d4f',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '022b3f99d429221a619f1674cd44ead1fc1c12a883e974d141f9b730c3a1b2a4',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '7bc0129e134c55613073338b75d9ad57557ea686c7959fb7cd7988bc3000a8bc',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'a991c2f1da9dd961f38b482c492e7aac8ec54167384e675e11c230ae9fc2085b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'fb90e24e898c3a70dc241ed60f7b1002ed3e04d5601a66df4aeb0dd4b5bbfd68',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '79859aa293f10aa6e52484eb1ad88b0243e6ed1eab113631d310ef1eaedc933c',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '0958ba7b92b152c9d8f69543b4d3c94882c4dc22de19546d8e4d4f71046495ea'},
               'overlays': {},
               'payloadSha256': '3afd4d9a25870c01da71b7cdacbdd4f1fff148134b133abcf7b6b71b74476e72',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '7eb0a4555bc0d9f3b65b85840bedaa10c88f602b9e741281f306d01cb8af3e5b',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '7c8e116d06615268df834fe363b7970f030b6d963aaa9bfb29686ea0810184bf'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'ef96009302e563a368f92961e2855037ebdd72058486d15836163a8e5d3de7b5',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.15.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '72567f0c7354dd5bd4c7e7d2582a0dc058936660f34104dafec3c442c266ebe7',
                                               'version': '0.15.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.5.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'e0b4f9f50cb2445ebbf53c8d0ddee5c353c05ba0d155fb5f0f4909d0a3023222',
                                                 'version': '0.5.0'}},
               'version': '0.28.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '508e70cc5b9a47b4313aef2324a5d35dcd2057303aab9535a98ca42b15b5959a',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '7e37651dcacfdccca38da89a2f0f933f2d2be2bf708602ae0c16767e2581af9a',
                         '.agents/skills/merge-reviewer/VERSION': 'f8405a7330c287028d470c3ee3506f878f1ad85ed79c1d1adc19df2ff7398915',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '3b8849c1476f9acdfa53fd6188bc1c8bffedf5157e0cb22377d9fd0b76b93680',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '68b4450250acd8dc2b9f8cb733878253be3959ba9fe14faa9f0c577280595d5d',
                         '.agents/skills/merge-reviewer/references/usage.md': '437acf9e4e7de1150db66a121dbb3b3b606d737e8f35dbd2d8f631b90d2a957d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '47aaf0b8b9a403db0fad256b436e9ee4ee42007f05170928660d2294595192ae',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '4d14ac814b975553170b773f02ad9ca73a512682b2574dd90e8290fba1aa2489',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '803faaf024e4d36c0f4cc2e5f04f052ce21e21e70f19b9b9a0b45a5cd9638644',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '7a6b4505bd2d3df8222a4527fa236b05b320f7fcf2a4c2efee5479d2597f91c7',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '53d82266d1126508fafdb8bab3c9298d0226edadf68b4cdad09e3fcf26da73b4',
                         '.agents/skills/release-reviewer/VERSION': 'a0ad50640139a524f86591157145bf1d4674ea9c065bfea21558f0f7b04430c8',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '3ef5d55b58469e2c7287200a3b1664f688dbe6c16b0970533a2fd8c3bac94d1e',
                         '.agents/skills/release-reviewer/references/group-review.md': '81abfbfc1c7bf01fd653afe62ed1fb1a7b49ad2f4c9c00f564a4834c79bd62f6',
                         '.agents/skills/release-reviewer/references/report-style.md': '1936b53c109bab53d94ca739612f6cf01b1ab49c44200758bc6bb58a5b3ca8e6',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'f4fbfc946d15dd2cfd74ff9916d278123f50943256a634b5d6878ed4bdf75e76',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '712d19533cc2400c33d4744fabf6193d85ed3dfdfae4170835fa28af560904e1',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': 'be5f9d5cfc7680e355a30d01eb55209377e15c0732ad6a5298c035cab72e0d4f',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '022b3f99d429221a619f1674cd44ead1fc1c12a883e974d141f9b730c3a1b2a4',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '7bc0129e134c55613073338b75d9ad57557ea686c7959fb7cd7988bc3000a8bc',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'a991c2f1da9dd961f38b482c492e7aac8ec54167384e675e11c230ae9fc2085b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'fb90e24e898c3a70dc241ed60f7b1002ed3e04d5601a66df4aeb0dd4b5bbfd68',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '79859aa293f10aa6e52484eb1ad88b0243e6ed1eab113631d310ef1eaedc933c',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '0958ba7b92b152c9d8f69543b4d3c94882c4dc22de19546d8e4d4f71046495ea'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
                                                                                                     'upstream_sha256': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4'}}}},
               'payloadSha256': 'f5d9dff74848b1bce03e38ad2e796b68e3a3dcfe4a98f811e628daa9e71c4eb0',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'a0ebfc46c673b7419077be14c66439740bf7972dde9774cc25148274f0202d3c',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '97e555f6d23d41fd03fc5d1ac4ea60b472c35b5afad36044124a6c1113b566e1'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'ef96009302e563a368f92961e2855037ebdd72058486d15836163a8e5d3de7b5',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.15.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '72567f0c7354dd5bd4c7e7d2582a0dc058936660f34104dafec3c442c266ebe7',
                                               'version': '0.15.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.5.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'e0b4f9f50cb2445ebbf53c8d0ddee5c353c05ba0d155fb5f0f4909d0a3023222',
                                                 'version': '0.5.0'}},
               'version': '0.28.1',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '1dc692c5cd1feed9bc333a02b298034bcac2d557c0b8db02bf74f3aab41e5f0c',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '8028970f1f55213bf4e4c4a81aaedb793864304f35d690341c9a42cf0ebb20ee',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '7e37651dcacfdccca38da89a2f0f933f2d2be2bf708602ae0c16767e2581af9a',
                         '.agents/skills/merge-reviewer/VERSION': 'f8405a7330c287028d470c3ee3506f878f1ad85ed79c1d1adc19df2ff7398915',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '3b8849c1476f9acdfa53fd6188bc1c8bffedf5157e0cb22377d9fd0b76b93680',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '68b4450250acd8dc2b9f8cb733878253be3959ba9fe14faa9f0c577280595d5d',
                         '.agents/skills/merge-reviewer/references/usage.md': '437acf9e4e7de1150db66a121dbb3b3b606d737e8f35dbd2d8f631b90d2a957d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '47aaf0b8b9a403db0fad256b436e9ee4ee42007f05170928660d2294595192ae',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '4d14ac814b975553170b773f02ad9ca73a512682b2574dd90e8290fba1aa2489',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': '33f3b93a16939fb4db35b7a416d9beb10c9b45727e03801944ad9f9cf31d3a0e',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '803faaf024e4d36c0f4cc2e5f04f052ce21e21e70f19b9b9a0b45a5cd9638644',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '7a6b4505bd2d3df8222a4527fa236b05b320f7fcf2a4c2efee5479d2597f91c7',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '53d82266d1126508fafdb8bab3c9298d0226edadf68b4cdad09e3fcf26da73b4',
                         '.agents/skills/release-reviewer/VERSION': 'a0ad50640139a524f86591157145bf1d4674ea9c065bfea21558f0f7b04430c8',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '3ef5d55b58469e2c7287200a3b1664f688dbe6c16b0970533a2fd8c3bac94d1e',
                         '.agents/skills/release-reviewer/references/group-review.md': '81abfbfc1c7bf01fd653afe62ed1fb1a7b49ad2f4c9c00f564a4834c79bd62f6',
                         '.agents/skills/release-reviewer/references/report-style.md': '1936b53c109bab53d94ca739612f6cf01b1ab49c44200758bc6bb58a5b3ca8e6',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'f4fbfc946d15dd2cfd74ff9916d278123f50943256a634b5d6878ed4bdf75e76',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '712d19533cc2400c33d4744fabf6193d85ed3dfdfae4170835fa28af560904e1',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': 'be5f9d5cfc7680e355a30d01eb55209377e15c0732ad6a5298c035cab72e0d4f',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '022b3f99d429221a619f1674cd44ead1fc1c12a883e974d141f9b730c3a1b2a4',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '7bc0129e134c55613073338b75d9ad57557ea686c7959fb7cd7988bc3000a8bc',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': 'a991c2f1da9dd961f38b482c492e7aac8ec54167384e675e11c230ae9fc2085b',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'fb90e24e898c3a70dc241ed60f7b1002ed3e04d5601a66df4aeb0dd4b5bbfd68',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '79859aa293f10aa6e52484eb1ad88b0243e6ed1eab113631d310ef1eaedc933c',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': '0958ba7b92b152c9d8f69543b4d3c94882c4dc22de19546d8e4d4f71046495ea'},
               'overlays': {},
               'payloadSha256': '3afd4d9a25870c01da71b7cdacbdd4f1fff148134b133abcf7b6b71b74476e72',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '7eb0a4555bc0d9f3b65b85840bedaa10c88f602b9e741281f306d01cb8af3e5b',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '7c8e116d06615268df834fe363b7970f030b6d963aaa9bfb29686ea0810184bf'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': 'ef96009302e563a368f92961e2855037ebdd72058486d15836163a8e5d3de7b5',
                                              'version': '0.6.2'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.15.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '72567f0c7354dd5bd4c7e7d2582a0dc058936660f34104dafec3c442c266ebe7',
                                               'version': '0.15.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.5.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'e0b4f9f50cb2445ebbf53c8d0ddee5c353c05ba0d155fb5f0f4909d0a3023222',
                                                 'version': '0.5.0'}},
               'version': '0.28.1',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '9c84286a521b46016023ab7792592d9aed548fc4878532da6630dd15a321b0b4',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c19f5dfbf664831cb12f5e295059b154ecfc10d5a872285b6bfd891b34b74b39',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': 'ef2c0a9198a5db5469ed6346599c18538003e0256533bc231f6aedfe46acdc0b',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '6a991678557aafa5e4c4a1e257bdfddf8322efbbfc4c174372859ce56e5e3ca9',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
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
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': '581f6462ba0ea6c13f432e103692b6700b67e493f64c5e923828e961aa4f5604',
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
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '27b88103e55b3fa9e6a50f1026dbb4560c769cc1658cca5abfb278c875880216',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '753c162c43e98549883ddd039c7f16cd290273f906715e14e757bbe9b4644037',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': 'be392beb5585811481f68a1ab4e3106013cb9f5ea1df09fda46c443c8602a444',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': 'b25b2438f81cce4b449117059499c499fae0c6563437b0f94d1ba8622ff9c60e',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '1de6c647f4e44f1dbfcf2a60a8d66d8f88a6bd72900b0e4d20f8d40577be3e6d',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '42fbfb2a4424c1b2f6b12ca492488f61ee893bbe120ba8cec2e87d7b4936bc6a',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': '13f1a60b64998bc35ed9a2b184e76971357b06244301d84d76f03ceee9429a4e',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494'},
               'wikiInstalledVersionSha256': 'a466ef209f5c3aee5ff0c702e2e9d5cced4783d2a655e8ab66330f21a5557b3f'},
              {'agentBlockSha256': '508e70cc5b9a47b4313aef2324a5d35dcd2057303aab9535a98ca42b15b5959a',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': 'c3c55d1811f182080e74e1b736fa1372fc830c3ceb4f5553873acedc7567c644',
                         '.agents/skills/merge-reviewer/VERSION': 'aa037454b5e8320521a32b278a3f4aff05fc79009ab5503f5d4a1b9a33b38c47',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '3b8849c1476f9acdfa53fd6188bc1c8bffedf5157e0cb22377d9fd0b76b93680',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '279159e1ca9d4326dfee2da3bc04616271793c5dd56380901ae0b2e7cb105751',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '004fa3e5dff2d76735aa8344541bf79fc0ca60ee26d28f667a3fa841907aa549',
                         '.agents/skills/merge-reviewer/references/usage.md': '437acf9e4e7de1150db66a121dbb3b3b606d737e8f35dbd2d8f631b90d2a957d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '47aaf0b8b9a403db0fad256b436e9ee4ee42007f05170928660d2294595192ae',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '46e31b356d98cd985cf9f0dc9e49eab65ad674fd9c3fb3b099da50a2c12fe1f5',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'c2939ca79f6439de4cc1066c62456d4a12d407d4626dd78bb10d9e8f5609cd5f',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'f1022523748be506219701afacbdc1756250710b467947a5ca308ffbc496fbe1',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '5fc71be1d1fa70094d68ac2e3282fcc895360cb0cbff9c0e679c4de1840fcd86',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'f647dbd8297ad595dd126d4ec4f38595acb22b8f0aef98eec23622c451096fd0',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': 'ba6af6ccaa5f2834fef6cf93d37f86fce45f39ce1d5dd87055a44a523f03684c',
                         '.agents/skills/release-reviewer/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '3ef5d55b58469e2c7287200a3b1664f688dbe6c16b0970533a2fd8c3bac94d1e',
                         '.agents/skills/release-reviewer/references/group-review.md': '81abfbfc1c7bf01fd653afe62ed1fb1a7b49ad2f4c9c00f564a4834c79bd62f6',
                         '.agents/skills/release-reviewer/references/report-style.md': '1936b53c109bab53d94ca739612f6cf01b1ab49c44200758bc6bb58a5b3ca8e6',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '89e07ad0297de24da02eb64f24f3e391b3df0b6de1d0d5fb80d24c1b104e23fb',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '99aa5edebb745016ebbcc80fa86b81aadae9344b1760dc31d1edf89bea8e49b1',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': 'be5f9d5cfc7680e355a30d01eb55209377e15c0732ad6a5298c035cab72e0d4f',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '1cbb6b9275128b62625e80defe85e57d4775699bd84ea07867b6888098784e8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': 'c3f2721229da2a78b1b741679ef69a4b18eed0286223c05bf2239a169ca067a3',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '52daf61a2731561307db536182b08d3b9b856e28cf6b36f693fe15364616c623',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'face024dc448daa8894d886855d6d03b874416c0447c9a41d59253a3a8c25ddb',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '251d0ec718b502338b0ad4ba71494ae1a575f0d822d51301744b079ce1129764',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': 'f1022523748be506219701afacbdc1756250710b467947a5ca308ffbc496fbe1',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'c978dad0dfa23d732092c34f52d49986ff74d841950a815d29e0e4501e2c41f9'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                                                                                                     'upstream_sha256': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a'}}}},
               'payloadSha256': '8fec3f188a63e20312b6253401d737cc8bb1c87eca53cf2ff1141949af7dddc3',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'a0ebfc46c673b7419077be14c66439740bf7972dde9774cc25148274f0202d3c',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '97e555f6d23d41fd03fc5d1ac4ea60b472c35b5afad36044124a6c1113b566e1'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.16.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '2f6ef73de0d6b3b30d6e628c567fd03f65525305e8072b6b7a82215574ec5b19',
                                               'version': '0.16.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.6.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '64451fda56a93d558667db721c2d281b02ee9e5a3ae04ef0a7d4a0cc9426b5a5',
                                                 'version': '0.6.0'}},
               'version': '0.29.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': '8028970f1f55213bf4e4c4a81aaedb793864304f35d690341c9a42cf0ebb20ee',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': 'c3c55d1811f182080e74e1b736fa1372fc830c3ceb4f5553873acedc7567c644',
                         '.agents/skills/merge-reviewer/VERSION': 'aa037454b5e8320521a32b278a3f4aff05fc79009ab5503f5d4a1b9a33b38c47',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '3b8849c1476f9acdfa53fd6188bc1c8bffedf5157e0cb22377d9fd0b76b93680',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '279159e1ca9d4326dfee2da3bc04616271793c5dd56380901ae0b2e7cb105751',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '004fa3e5dff2d76735aa8344541bf79fc0ca60ee26d28f667a3fa841907aa549',
                         '.agents/skills/merge-reviewer/references/usage.md': '437acf9e4e7de1150db66a121dbb3b3b606d737e8f35dbd2d8f631b90d2a957d',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '47aaf0b8b9a403db0fad256b436e9ee4ee42007f05170928660d2294595192ae',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '46e31b356d98cd985cf9f0dc9e49eab65ad674fd9c3fb3b099da50a2c12fe1f5',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'c2939ca79f6439de4cc1066c62456d4a12d407d4626dd78bb10d9e8f5609cd5f',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'f1022523748be506219701afacbdc1756250710b467947a5ca308ffbc496fbe1',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '5fc71be1d1fa70094d68ac2e3282fcc895360cb0cbff9c0e679c4de1840fcd86',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'f647dbd8297ad595dd126d4ec4f38595acb22b8f0aef98eec23622c451096fd0',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': 'ba6af6ccaa5f2834fef6cf93d37f86fce45f39ce1d5dd87055a44a523f03684c',
                         '.agents/skills/release-reviewer/VERSION': '97a5d6e540a6120d09c39ddb667e0e8e2bac7fcc2ffef813b82e08fd60365bce',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '3ef5d55b58469e2c7287200a3b1664f688dbe6c16b0970533a2fd8c3bac94d1e',
                         '.agents/skills/release-reviewer/references/group-review.md': '81abfbfc1c7bf01fd653afe62ed1fb1a7b49ad2f4c9c00f564a4834c79bd62f6',
                         '.agents/skills/release-reviewer/references/report-style.md': '1936b53c109bab53d94ca739612f6cf01b1ab49c44200758bc6bb58a5b3ca8e6',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '89e07ad0297de24da02eb64f24f3e391b3df0b6de1d0d5fb80d24c1b104e23fb',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '99aa5edebb745016ebbcc80fa86b81aadae9344b1760dc31d1edf89bea8e49b1',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': 'be5f9d5cfc7680e355a30d01eb55209377e15c0732ad6a5298c035cab72e0d4f',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '1cbb6b9275128b62625e80defe85e57d4775699bd84ea07867b6888098784e8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': 'c3f2721229da2a78b1b741679ef69a4b18eed0286223c05bf2239a169ca067a3',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '52daf61a2731561307db536182b08d3b9b856e28cf6b36f693fe15364616c623',
                         '.agents/skills/release-reviewer/scripts/git_support.py': 'face024dc448daa8894d886855d6d03b874416c0447c9a41d59253a3a8c25ddb',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '251d0ec718b502338b0ad4ba71494ae1a575f0d822d51301744b079ce1129764',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': 'f1022523748be506219701afacbdc1756250710b467947a5ca308ffbc496fbe1',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'c978dad0dfa23d732092c34f52d49986ff74d841950a815d29e0e4501e2c41f9'},
               'overlays': {},
               'payloadSha256': '0b3477d6117931dd4c96edcb8329aff10385017ac504f3728ca526ced4db8be0',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '7eb0a4555bc0d9f3b65b85840bedaa10c88f602b9e741281f306d01cb8af3e5b',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '7c8e116d06615268df834fe363b7970f030b6d963aaa9bfb29686ea0810184bf'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.16.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '2f6ef73de0d6b3b30d6e628c567fd03f65525305e8072b6b7a82215574ec5b19',
                                               'version': '0.16.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.6.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': '64451fda56a93d558667db721c2d281b02ee9e5a3ae04ef0a7d4a0cc9426b5a5',
                                                 'version': '0.6.0'}},
               'version': '0.29.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': '508e70cc5b9a47b4313aef2324a5d35dcd2057303aab9535a98ca42b15b5959a',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': 'c1d7794e2448f320d41d5b5ba3a269c1d8174a68801ce36058c7648951968f21',
                         '.agents/skills/merge-reviewer/VERSION': '02d38e98e88f4a8dc2ea40dbb769338601066fc94920b52882a14f21ad97f7ee',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '92c612f9d629233094f0d897347393e7823186c87bc16244522780097fdbdd15',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '279159e1ca9d4326dfee2da3bc04616271793c5dd56380901ae0b2e7cb105751',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '3c948d2e6f0ba3e76ae81a68b7c4aaef23c270335795175af92169e18837458d',
                         '.agents/skills/merge-reviewer/references/usage.md': '5c18f1fc512632464ed4d8d285c04c15f5c1f5e9d12604f0cd2699fe8044ce55',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '34f934b62e7ef7a742b55ff42585f65527e355b877080d2b6841a32c57a04a65',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '2b8b0d9aa279a38b0904eed1fd05012411190ede4f3bd79cc979c9f782b49f18',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'c2939ca79f6439de4cc1066c62456d4a12d407d4626dd78bb10d9e8f5609cd5f',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': '9f45b98dc94b4e6cba3edef71fc8a2891666190523f8adf9fe8efe020a8b7d41',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '106fe163629ee8e507ed14db5705346a303c5e2fc626a49207a0728e172548ca',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'cb99dab1f45033d6d3f22c15bed1b8cef2c82a63a4ce90fb8a4109e7e25318a2',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '13447bfb604921f4a512f3648c26d2c5f8e0af94f182242e95e0701fc96e2b5d',
                         '.agents/skills/release-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': '887327fcd4bdd628f9e22fd28ac9490a65697b8ce98fb5f1713aa4437d473452',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '359c231ab64711bba94785889742d1055f6a984898fc4ce37337ffaf322e8637',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '3aae3fb12339ba15dae5b8ae8e54240cbabf38b99a3335700bad11ca88fdeb8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '5940bd44e79c3b9f89b0ae528f27f6268f0eb1bfe70dd4e3b16749dbcd98243e',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '0696128eac80aed9b5de4e6a534c3a54866055e39380c77acdb4e985f3e39822',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '5bd00e5e6089af1c31067e8abd7732c4ca24f6a1efea9330e7d16b39433b79d5',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'fab4ee29619c8830799143abc56a03167029b0f550969039f5c6bc5259783942',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '007a1dba225c13f37a287c1b61ecb12133bf3a30916f1da9c05bc74eacebeeb5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                                                                                                     'upstream_sha256': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a'}}}},
               'payloadSha256': '7e84ad5478f9d48ebec9c62aeb6a24b75628108dac7324e8cee3e3183e0ea37b',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'a0ebfc46c673b7419077be14c66439740bf7972dde9774cc25148274f0202d3c',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '97e555f6d23d41fd03fc5d1ac4ea60b472c35b5afad36044124a6c1113b566e1'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.17.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'affdd9c66e7a8b7c500021a277fb1e6dd45625d160d3fec9cfb1445aacf1a596',
                                               'version': '0.17.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.7.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a24a7e600d44b82773f75109f622133fd9ee2da17ab8fd3e6dce634662960253',
                                                 'version': '0.7.0'}},
               'version': '0.30.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': '8028970f1f55213bf4e4c4a81aaedb793864304f35d690341c9a42cf0ebb20ee',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': 'c1d7794e2448f320d41d5b5ba3a269c1d8174a68801ce36058c7648951968f21',
                         '.agents/skills/merge-reviewer/VERSION': '02d38e98e88f4a8dc2ea40dbb769338601066fc94920b52882a14f21ad97f7ee',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '92c612f9d629233094f0d897347393e7823186c87bc16244522780097fdbdd15',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '279159e1ca9d4326dfee2da3bc04616271793c5dd56380901ae0b2e7cb105751',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '3c948d2e6f0ba3e76ae81a68b7c4aaef23c270335795175af92169e18837458d',
                         '.agents/skills/merge-reviewer/references/usage.md': '5c18f1fc512632464ed4d8d285c04c15f5c1f5e9d12604f0cd2699fe8044ce55',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '34f934b62e7ef7a742b55ff42585f65527e355b877080d2b6841a32c57a04a65',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '2b8b0d9aa279a38b0904eed1fd05012411190ede4f3bd79cc979c9f782b49f18',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'c2939ca79f6439de4cc1066c62456d4a12d407d4626dd78bb10d9e8f5609cd5f',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': '9f45b98dc94b4e6cba3edef71fc8a2891666190523f8adf9fe8efe020a8b7d41',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '106fe163629ee8e507ed14db5705346a303c5e2fc626a49207a0728e172548ca',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'cb99dab1f45033d6d3f22c15bed1b8cef2c82a63a4ce90fb8a4109e7e25318a2',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '13447bfb604921f4a512f3648c26d2c5f8e0af94f182242e95e0701fc96e2b5d',
                         '.agents/skills/release-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': '887327fcd4bdd628f9e22fd28ac9490a65697b8ce98fb5f1713aa4437d473452',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '359c231ab64711bba94785889742d1055f6a984898fc4ce37337ffaf322e8637',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '3aae3fb12339ba15dae5b8ae8e54240cbabf38b99a3335700bad11ca88fdeb8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '5940bd44e79c3b9f89b0ae528f27f6268f0eb1bfe70dd4e3b16749dbcd98243e',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '0696128eac80aed9b5de4e6a534c3a54866055e39380c77acdb4e985f3e39822',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '5bd00e5e6089af1c31067e8abd7732c4ca24f6a1efea9330e7d16b39433b79d5',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'fab4ee29619c8830799143abc56a03167029b0f550969039f5c6bc5259783942',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '007a1dba225c13f37a287c1b61ecb12133bf3a30916f1da9c05bc74eacebeeb5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {},
               'payloadSha256': '1bd51e82267a3882a172f60169835440244ba90b50c9e8745731a6d8e15e8c85',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '7eb0a4555bc0d9f3b65b85840bedaa10c88f602b9e741281f306d01cb8af3e5b',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '7c8e116d06615268df834fe363b7970f030b6d963aaa9bfb29686ea0810184bf'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.17.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'affdd9c66e7a8b7c500021a277fb1e6dd45625d160d3fec9cfb1445aacf1a596',
                                               'version': '0.17.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.7.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a24a7e600d44b82773f75109f622133fd9ee2da17ab8fd3e6dce634662960253',
                                                 'version': '0.7.0'}},
               'version': '0.30.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': '508e70cc5b9a47b4313aef2324a5d35dcd2057303aab9535a98ca42b15b5959a',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': 'c1d7794e2448f320d41d5b5ba3a269c1d8174a68801ce36058c7648951968f21',
                         '.agents/skills/merge-reviewer/VERSION': '02d38e98e88f4a8dc2ea40dbb769338601066fc94920b52882a14f21ad97f7ee',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '92c612f9d629233094f0d897347393e7823186c87bc16244522780097fdbdd15',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '279159e1ca9d4326dfee2da3bc04616271793c5dd56380901ae0b2e7cb105751',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '3c948d2e6f0ba3e76ae81a68b7c4aaef23c270335795175af92169e18837458d',
                         '.agents/skills/merge-reviewer/references/usage.md': '5c18f1fc512632464ed4d8d285c04c15f5c1f5e9d12604f0cd2699fe8044ce55',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '34f934b62e7ef7a742b55ff42585f65527e355b877080d2b6841a32c57a04a65',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '2b8b0d9aa279a38b0904eed1fd05012411190ede4f3bd79cc979c9f782b49f18',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'c2939ca79f6439de4cc1066c62456d4a12d407d4626dd78bb10d9e8f5609cd5f',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': '9f45b98dc94b4e6cba3edef71fc8a2891666190523f8adf9fe8efe020a8b7d41',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '106fe163629ee8e507ed14db5705346a303c5e2fc626a49207a0728e172548ca',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'cb99dab1f45033d6d3f22c15bed1b8cef2c82a63a4ce90fb8a4109e7e25318a2',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '13447bfb604921f4a512f3648c26d2c5f8e0af94f182242e95e0701fc96e2b5d',
                         '.agents/skills/release-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': '887327fcd4bdd628f9e22fd28ac9490a65697b8ce98fb5f1713aa4437d473452',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '359c231ab64711bba94785889742d1055f6a984898fc4ce37337ffaf322e8637',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '3aae3fb12339ba15dae5b8ae8e54240cbabf38b99a3335700bad11ca88fdeb8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '5940bd44e79c3b9f89b0ae528f27f6268f0eb1bfe70dd4e3b16749dbcd98243e',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '0696128eac80aed9b5de4e6a534c3a54866055e39380c77acdb4e985f3e39822',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '5bd00e5e6089af1c31067e8abd7732c4ca24f6a1efea9330e7d16b39433b79d5',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'fab4ee29619c8830799143abc56a03167029b0f550969039f5c6bc5259783942',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '007a1dba225c13f37a287c1b61ecb12133bf3a30916f1da9c05bc74eacebeeb5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                                                                                                     'upstream_sha256': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a'}}}},
               'payloadSha256': '7e84ad5478f9d48ebec9c62aeb6a24b75628108dac7324e8cee3e3183e0ea37b',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'a0ebfc46c673b7419077be14c66439740bf7972dde9774cc25148274f0202d3c',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '97e555f6d23d41fd03fc5d1ac4ea60b472c35b5afad36044124a6c1113b566e1'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.17.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'affdd9c66e7a8b7c500021a277fb1e6dd45625d160d3fec9cfb1445aacf1a596',
                                               'version': '0.17.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.7.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a24a7e600d44b82773f75109f622133fd9ee2da17ab8fd3e6dce634662960253',
                                                 'version': '0.7.0'}},
               'version': '0.30.1',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': '8028970f1f55213bf4e4c4a81aaedb793864304f35d690341c9a42cf0ebb20ee',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': 'c1d7794e2448f320d41d5b5ba3a269c1d8174a68801ce36058c7648951968f21',
                         '.agents/skills/merge-reviewer/VERSION': '02d38e98e88f4a8dc2ea40dbb769338601066fc94920b52882a14f21ad97f7ee',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '92c612f9d629233094f0d897347393e7823186c87bc16244522780097fdbdd15',
                         '.agents/skills/merge-reviewer/references/review-rules.md': '279159e1ca9d4326dfee2da3bc04616271793c5dd56380901ae0b2e7cb105751',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '3c948d2e6f0ba3e76ae81a68b7c4aaef23c270335795175af92169e18837458d',
                         '.agents/skills/merge-reviewer/references/usage.md': '5c18f1fc512632464ed4d8d285c04c15f5c1f5e9d12604f0cd2699fe8044ce55',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '34f934b62e7ef7a742b55ff42585f65527e355b877080d2b6841a32c57a04a65',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': '2b8b0d9aa279a38b0904eed1fd05012411190ede4f3bd79cc979c9f782b49f18',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'c2939ca79f6439de4cc1066c62456d4a12d407d4626dd78bb10d9e8f5609cd5f',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': '9f45b98dc94b4e6cba3edef71fc8a2891666190523f8adf9fe8efe020a8b7d41',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': '5e7845821c85e4d3cd867928aa02379e592dd7cb1a6653b2da1d549b393026ea',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '106fe163629ee8e507ed14db5705346a303c5e2fc626a49207a0728e172548ca',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'cb99dab1f45033d6d3f22c15bed1b8cef2c82a63a4ce90fb8a4109e7e25318a2',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '13447bfb604921f4a512f3648c26d2c5f8e0af94f182242e95e0701fc96e2b5d',
                         '.agents/skills/release-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': '887327fcd4bdd628f9e22fd28ac9490a65697b8ce98fb5f1713aa4437d473452',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '359c231ab64711bba94785889742d1055f6a984898fc4ce37337ffaf322e8637',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '3aae3fb12339ba15dae5b8ae8e54240cbabf38b99a3335700bad11ca88fdeb8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '5940bd44e79c3b9f89b0ae528f27f6268f0eb1bfe70dd4e3b16749dbcd98243e',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '0696128eac80aed9b5de4e6a534c3a54866055e39380c77acdb4e985f3e39822',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '5bd00e5e6089af1c31067e8abd7732c4ca24f6a1efea9330e7d16b39433b79d5',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'fab4ee29619c8830799143abc56a03167029b0f550969039f5c6bc5259783942',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '007a1dba225c13f37a287c1b61ecb12133bf3a30916f1da9c05bc74eacebeeb5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {},
               'payloadSha256': '1bd51e82267a3882a172f60169835440244ba90b50c9e8745731a6d8e15e8c85',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '7eb0a4555bc0d9f3b65b85840bedaa10c88f602b9e741281f306d01cb8af3e5b',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '7c8e116d06615268df834fe363b7970f030b6d963aaa9bfb29686ea0810184bf'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.17.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': 'affdd9c66e7a8b7c500021a277fb1e6dd45625d160d3fec9cfb1445aacf1a596',
                                               'version': '0.17.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.7.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a24a7e600d44b82773f75109f622133fd9ee2da17ab8fd3e6dce634662960253',
                                                 'version': '0.7.0'}},
               'version': '0.30.1',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': '44bd22883f710a5c92ab02b5ea9ae4ad0fa9605c9dbf301924219eed21f8eaad',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '0e92510d9d545f4545dcc1913c2a8420606e2811b5e7704d5cb8ab7424431b07',
                         '.agents/skills/merge-reviewer/VERSION': 'f5e9382967c9833066a55808829f3750fc8e1181b170cafd222c37048bb49a77',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '21bd5e766a972d18f76a5f64c20bb5e48ec830760b94a50d55109ff6d21e17ff',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'db76edd3e4d070480b49df4abcca2ce2ea35d2a2a6e30954e80ce3d2f0f99f6c',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '7cba72230453a93e0f7e6f8a2fabd80cad2a07b226f58e02ea5db8b7794b5902',
                         '.agents/skills/merge-reviewer/references/session-workflow.md': '526954452d8bd90b35aca73a01de5e33eb3c01b35c0330186e27c34ecd50763a',
                         '.agents/skills/merge-reviewer/references/usage.md': '026347de479db94587dd5c12608a72efba74a0e5fca91508806e1129801e4818',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '42c5c5794bb840a7a21a7d60cb7fa14dabddbcdb884f7162221e6766e5521fa4',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '1555269f41f711d443b8d107b960824c4836c140624bc461470d07f7a05fda1b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e448c5c8010131498559d8c646f6e6fc67a4c7d1ee773b578d8b2e7552118679',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_coordinator.py': '223ea0c90f41aa3c922768a987e26e47b38a0b66f276b176cd101959727015cf',
                         '.agents/skills/merge-reviewer/scripts/review_flow.py': '21776448dd5b5e2549e6691cc545f1c54dadafe506029f8796af6d4208dbbb1b',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'cb35198238547dfe35d23d2fbbe326eedaaa5d9d43d6e21e3aa6b69a37f0f1d9',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'a39c46efa69c7a1803460782b5b94392b1e0ccc985afef2434b086f1f907d30c',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': 'de7601f525c053d71544053ddd24c4aa22b658c6949f0b6100b888588484eeb0',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'eb5673eb510513a8378b3dfe2e70412938554b39f055efe3f968fd2c5aaca720',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'fb23ce23af67a2ed87ca6fcf029ee23004f0de4f6a30be5f6dfbbf4a6a28c37a',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '13447bfb604921f4a512f3648c26d2c5f8e0af94f182242e95e0701fc96e2b5d',
                         '.agents/skills/release-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': '887327fcd4bdd628f9e22fd28ac9490a65697b8ce98fb5f1713aa4437d473452',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '359c231ab64711bba94785889742d1055f6a984898fc4ce37337ffaf322e8637',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '3aae3fb12339ba15dae5b8ae8e54240cbabf38b99a3335700bad11ca88fdeb8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '5940bd44e79c3b9f89b0ae528f27f6268f0eb1bfe70dd4e3b16749dbcd98243e',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '0696128eac80aed9b5de4e6a534c3a54866055e39380c77acdb4e985f3e39822',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '5bd00e5e6089af1c31067e8abd7732c4ca24f6a1efea9330e7d16b39433b79d5',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'fab4ee29619c8830799143abc56a03167029b0f550969039f5c6bc5259783942',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '007a1dba225c13f37a287c1b61ecb12133bf3a30916f1da9c05bc74eacebeeb5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                                                                                                     'upstream_sha256': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a'}}}},
               'payloadSha256': 'ea045bcbfaff6b09b33181807eefe8c3b0e3ee76b550d158f5c9748fa4ef3ec5',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': 'a97310a79096f76f3928ae15b918cb3a9aff25ffced759b2614a163ebf20cef1',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': 'c3ccd37d5486890e23de99a99c438b443299bee5fff7aa5d09fa6676f75279b2'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.18.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '12ad5716d4e53e83b31095776320fcfe0c81be3b8f9e72ec1c20cbd092299001',
                                               'version': '0.18.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.7.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a24a7e600d44b82773f75109f622133fd9ee2da17ab8fd3e6dce634662960253',
                                                 'version': '0.7.0'}},
               'version': '0.31.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': 'df8ebd0e70b8eb6b0f605834c53224349567286da0ad1c5b1915e9cd5daa290f',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '0e92510d9d545f4545dcc1913c2a8420606e2811b5e7704d5cb8ab7424431b07',
                         '.agents/skills/merge-reviewer/VERSION': 'f5e9382967c9833066a55808829f3750fc8e1181b170cafd222c37048bb49a77',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/report-style.md': '21bd5e766a972d18f76a5f64c20bb5e48ec830760b94a50d55109ff6d21e17ff',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'db76edd3e4d070480b49df4abcca2ce2ea35d2a2a6e30954e80ce3d2f0f99f6c',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '7cba72230453a93e0f7e6f8a2fabd80cad2a07b226f58e02ea5db8b7794b5902',
                         '.agents/skills/merge-reviewer/references/session-workflow.md': '526954452d8bd90b35aca73a01de5e33eb3c01b35c0330186e27c34ecd50763a',
                         '.agents/skills/merge-reviewer/references/usage.md': '026347de479db94587dd5c12608a72efba74a0e5fca91508806e1129801e4818',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': '42c5c5794bb840a7a21a7d60cb7fa14dabddbcdb884f7162221e6766e5521fa4',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '1555269f41f711d443b8d107b960824c4836c140624bc461470d07f7a05fda1b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e448c5c8010131498559d8c646f6e6fc67a4c7d1ee773b578d8b2e7552118679',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/review_coordinator.py': '223ea0c90f41aa3c922768a987e26e47b38a0b66f276b176cd101959727015cf',
                         '.agents/skills/merge-reviewer/scripts/review_flow.py': '21776448dd5b5e2549e6691cc545f1c54dadafe506029f8796af6d4208dbbb1b',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'cb35198238547dfe35d23d2fbbe326eedaaa5d9d43d6e21e3aa6b69a37f0f1d9',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'a39c46efa69c7a1803460782b5b94392b1e0ccc985afef2434b086f1f907d30c',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': 'de7601f525c053d71544053ddd24c4aa22b658c6949f0b6100b888588484eeb0',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': 'eb5673eb510513a8378b3dfe2e70412938554b39f055efe3f968fd2c5aaca720',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': 'fb23ce23af67a2ed87ca6fcf029ee23004f0de4f6a30be5f6dfbbf4a6a28c37a',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '13447bfb604921f4a512f3648c26d2c5f8e0af94f182242e95e0701fc96e2b5d',
                         '.agents/skills/release-reviewer/VERSION': '967d9afb101346667166f2e76e81910bc190488d7d41d50ca0072e9d92f00e32',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': '887327fcd4bdd628f9e22fd28ac9490a65697b8ce98fb5f1713aa4437d473452',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': '359c231ab64711bba94785889742d1055f6a984898fc4ce37337ffaf322e8637',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '3aae3fb12339ba15dae5b8ae8e54240cbabf38b99a3335700bad11ca88fdeb8e',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '5940bd44e79c3b9f89b0ae528f27f6268f0eb1bfe70dd4e3b16749dbcd98243e',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '0696128eac80aed9b5de4e6a534c3a54866055e39380c77acdb4e985f3e39822',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '5bd00e5e6089af1c31067e8abd7732c4ca24f6a1efea9330e7d16b39433b79d5',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': 'fab4ee29619c8830799143abc56a03167029b0f550969039f5c6bc5259783942',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '007a1dba225c13f37a287c1b61ecb12133bf3a30916f1da9c05bc74eacebeeb5',
                         '.agents/skills/release-reviewer/scripts/review_session.py': '6cd4a5bbd0351fb1e65326c2823d19201cceb80be40e8565f47d8bd958053025',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {},
               'payloadSha256': '99e4d2f3dd2d4919392641645a7fc161a77cc62d370a6b37d7d06e3f09e25f11',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '681e4371add7983a2219f68d8c644ddbe5e3b877252f25c4cdd6cda104732241',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '39c2d331fe5a677355558e2c6cd9d88a62361926d78c01d841182750d22f78a8'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.18.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '12ad5716d4e53e83b31095776320fcfe0c81be3b8f9e72ec1c20cbd092299001',
                                               'version': '0.18.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.7.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'a24a7e600d44b82773f75109f622133fd9ee2da17ab8fd3e6dce634662960253',
                                                 'version': '0.7.0'}},
               'version': '0.31.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': 'b03d76dc4cc2c42dc9cd881098d782d537188d9f860a5cb6ab48f07f297ad8cf',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '36adab3bca4d9b30fbeab7510e68b024dc7976777dd6937d2166c64055cdd0ea',
                         '.agents/skills/merge-reviewer/VERSION': '06c53dd4f22b2e0038ca2bb9af32cc1ab7e69898d99cc3bfa22bd965f21aac8f',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/contract-boundaries.md': 'dac84f58c6305cf6825f6595e028e0af60feef9b9d95061b00b1b5877bb21529',
                         '.agents/skills/merge-reviewer/references/report-style.md': '21bd5e766a972d18f76a5f64c20bb5e48ec830760b94a50d55109ff6d21e17ff',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'db76edd3e4d070480b49df4abcca2ce2ea35d2a2a6e30954e80ce3d2f0f99f6c',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '325d133901aa928ba720763a8c0cf9628ddcb64084204bb3a67a53a33c4c8221',
                         '.agents/skills/merge-reviewer/references/session-workflow.md': 'd514812c8b8bb5b409e0891f7393d0d9ccfc406c1737f23121d03d1512780adc',
                         '.agents/skills/merge-reviewer/references/usage.md': '026347de479db94587dd5c12608a72efba74a0e5fca91508806e1129801e4818',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'ff995f1e64a16534ff28637a8215d76ee1e13870be7b33e11219a8838a1b0ef6',
                         '.agents/skills/merge-reviewer/scripts/contract_boundary.py': 'f864aceb8dc75fbc1fc58d7926f9c208adf5dcad11899dfb3339d4c7682ca0d1',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '1555269f41f711d443b8d107b960824c4836c140624bc461470d07f7a05fda1b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e448c5c8010131498559d8c646f6e6fc67a4c7d1ee773b578d8b2e7552118679',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/report_receipt.py': 'd81e17396e5586071081f942a09ad08b16c2c6a8cdacb4735f3986f19b5d953e',
                         '.agents/skills/merge-reviewer/scripts/review_coordinator.py': '223ea0c90f41aa3c922768a987e26e47b38a0b66f276b176cd101959727015cf',
                         '.agents/skills/merge-reviewer/scripts/review_diagnostics.py': '5314c74dd38fe50d144c0be4f1adfe9e34da173b8654923726bbfbba0d58cad6',
                         '.agents/skills/merge-reviewer/scripts/review_flow.py': '9a84ba6429f38fb75e8dcfb8c1b12d5a034192084057590db74d4eecd6ef45af',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'e3b13b89514216b6957b2d825b472a8b976fd7f5b1e392dc1a99fb63504e5da1',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'a39c46efa69c7a1803460782b5b94392b1e0ccc985afef2434b086f1f907d30c',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': 'baf3b999af6e6a71893761768000345d2f7d450731d64614f44a1556079197e8',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '267ed29e90f284deeb2282393f10e9b97e48244b4df47155791a3d69fe39fabc',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '2e58bea4fae685e5d3bc7e0cd848568ccfa6edfb844e792112dda7ac721a85f1',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '75c9c7bd8b88bb2deabc30b0f2e471fac5fde1462efb64f582d9080a6debe64f',
                         '.agents/skills/release-reviewer/VERSION': 'a66780da23103beaf12432b418508966b31a2a3a787f9468a5b6cdaa8667c1ef',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': 'ff3d8c097a8f4d10cad7646156728c9e0adea1ef4aa86075cc63c457181d651a',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': 'b4b74ff5ce210e3638f5f74970641500f29ef8efc72ead8269fc422c7f7f8953',
                         '.agents/skills/release-reviewer/references/session-workflow.md': '5bd96300ab6fa806101b534c4f5c2e97b20b785e16882f148206ceda7d040e07',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '5fe9366fa52bfd17c17477001674f0575c732d4dc5a03a94a0e0e2ddc92dc34d',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '8dae6dcdfdbe0570808ea1d9463d9ec226595c5fb6b655738eb4141e4db1ae8a',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '5efbd08f682adf22b0d9712e51d384fd86faabc5dca9f4a59f59c6aa9efda973',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9732c261fdcb476a965753730421a73029b72c4fc6cb5b6e70bcf33a010acd5a',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '63e487a689d002cc3185f63095b9f31c786d55d6237591695299b5fdb64da3c4',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_coordinator.py': '6ed42471507e2e2c3591576d565f67ac3ef65092f85e3b5bf00272c6c6d15edc',
                         '.agents/skills/release-reviewer/scripts/review_flow.py': 'd461fa14bc17f6bd1184b65d2290b1d9d5259510963876e215ba94efb450ce8f',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '71957e980353e8a7d8fefdeb61e35c2f4349c309bc6d194d5aefbea47419e8d7',
                         '.agents/skills/release-reviewer/scripts/review_session.py': 'fa93f1327c658df7d354104d9e504665ac0b8a2594533b9f19d289aa4e9d4f6a',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {'codebase-wiki': {'added': {},
                                              'replaced': {'.agents/skills/codebase-wiki/SKILL.md': {'overlay_sha256': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                                                                                                     'upstream_sha256': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a'}}}},
               'payloadSha256': 'a02dbf62399d34af2828c4caef94ad59fa2a0ad53795cd4670302d078ff805d0',
               'profile': 'group',
               'profileHashes': {'group-instructions.md': '1f744c41872cf78cf3a4091a18c33a1861af39cd93b3e91b112800592f96064b',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': 'db5734e5cf5eaffbc6894d241e6cc4f687b84b577db95cbceefc4c4324b0ca88'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.19.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '74fcd02ff44b7d3c6e7a7cbe50bcc17f17ff63a8ca3d6c922de53d2ab6d3c32e',
                                               'version': '0.19.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.8.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'b6ba140cd12db38fbe0ff2a43c142515197826b69891785f16e34e5012294a72',
                                                 'version': '0.8.0'}},
               'version': '0.32.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': '80be38684e6f27d969dc548aa6bad997105f842bbf054d3af44ae2a439fbdf99',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'},
              {'agentBlockSha256': 'fc63afed6c0c02f320f84a92faf15cff58d934531812c9d303e1d1b31f8815f3',
               'capabilities': ['adr',
                                'archaeology',
                                'audit',
                                'business-analysis',
                                'functional-exploration',
                                'ingest',
                                'lint',
                                'merge-repo',
                                'notebooklm-export',
                                'query',
                                'release-review',
                                'synthesis',
                                'system-analysis',
                                'system-design'],
               'extensionFiles': {},
               'files': {'.agents/skills/merge-reviewer/SKILL.md': '36adab3bca4d9b30fbeab7510e68b024dc7976777dd6937d2166c64055cdd0ea',
                         '.agents/skills/merge-reviewer/VERSION': '06c53dd4f22b2e0038ca2bb9af32cc1ab7e69898d99cc3bfa22bd965f21aac8f',
                         '.agents/skills/merge-reviewer/agents/openai.yaml': 'b5ed995d59e34d9d8f555a00f1dd30fc6593dda071f16e0eb8e58e4c5f3495f5',
                         '.agents/skills/merge-reviewer/references/claude-code-style.md': 'f730bd868052261947a6e4ae64abf9b419250f30d04c44637459abf8bcf6219e',
                         '.agents/skills/merge-reviewer/references/contract-boundaries.md': 'dac84f58c6305cf6825f6595e028e0af60feef9b9d95061b00b1b5877bb21529',
                         '.agents/skills/merge-reviewer/references/report-style.md': '21bd5e766a972d18f76a5f64c20bb5e48ec830760b94a50d55109ff6d21e17ff',
                         '.agents/skills/merge-reviewer/references/review-rules.md': 'db76edd3e4d070480b49df4abcca2ce2ea35d2a2a6e30954e80ce3d2f0f99f6c',
                         '.agents/skills/merge-reviewer/references/runtime-controls.md': '325d133901aa928ba720763a8c0cf9628ddcb64084204bb3a67a53a33c4c8221',
                         '.agents/skills/merge-reviewer/references/session-workflow.md': 'd514812c8b8bb5b409e0891f7393d0d9ccfc406c1737f23121d03d1512780adc',
                         '.agents/skills/merge-reviewer/references/usage.md': '026347de479db94587dd5c12608a72efba74a0e5fca91508806e1129801e4818',
                         '.agents/skills/merge-reviewer/references/workspace-review.md': 'ff995f1e64a16534ff28637a8215d76ee1e13870be7b33e11219a8838a1b0ef6',
                         '.agents/skills/merge-reviewer/scripts/contract_boundary.py': 'f864aceb8dc75fbc1fc58d7926f9c208adf5dcad11899dfb3339d4c7682ca0d1',
                         '.agents/skills/merge-reviewer/scripts/git_network_lease.py': '1555269f41f711d443b8d107b960824c4836c140624bc461470d07f7a05fda1b',
                         '.agents/skills/merge-reviewer/scripts/git_review_context.py': 'e448c5c8010131498559d8c646f6e6fc67a4c7d1ee773b578d8b2e7552118679',
                         '.agents/skills/merge-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/merge-reviewer/scripts/report_receipt.py': 'd81e17396e5586071081f942a09ad08b16c2c6a8cdacb4735f3986f19b5d953e',
                         '.agents/skills/merge-reviewer/scripts/review_coordinator.py': '223ea0c90f41aa3c922768a987e26e47b38a0b66f276b176cd101959727015cf',
                         '.agents/skills/merge-reviewer/scripts/review_diagnostics.py': '5314c74dd38fe50d144c0be4f1adfe9e34da173b8654923726bbfbba0d58cad6',
                         '.agents/skills/merge-reviewer/scripts/review_flow.py': '9a84ba6429f38fb75e8dcfb8c1b12d5a034192084057590db74d4eecd6ef45af',
                         '.agents/skills/merge-reviewer/scripts/review_report.py': 'e3b13b89514216b6957b2d825b472a8b976fd7f5b1e392dc1a99fb63504e5da1',
                         '.agents/skills/merge-reviewer/scripts/review_runtime.py': 'a39c46efa69c7a1803460782b5b94392b1e0ccc985afef2434b086f1f907d30c',
                         '.agents/skills/merge-reviewer/scripts/review_session.py': 'baf3b999af6e6a71893761768000345d2f7d450731d64614f44a1556079197e8',
                         '.agents/skills/merge-reviewer/scripts/review_workspace.py': '267ed29e90f284deeb2282393f10e9b97e48244b4df47155791a3d69fe39fabc',
                         '.agents/skills/merge-reviewer/scripts/workspace_report.py': '2e58bea4fae685e5d3bc7e0cd848568ccfa6edfb844e792112dda7ac721a85f1',
                         '.agents/skills/output-style/SKILL.md': 'e356f9440faadbd20f659a86ebe8ae986150edf065d3098a6c343e0303de4eaf',
                         '.agents/skills/output-style/agents/openai.yaml': '9311f7948fcff9ee737b8c0360e198517afcdcda04bc483b072357bce751cbbb',
                         '.agents/skills/output-style/references/examples.md': '997eb1deedd5719f733f980161e5e951cbaf69b5878fb855c54cd03ea6badabf',
                         '.agents/skills/release-reviewer/SKILL.md': '75c9c7bd8b88bb2deabc30b0f2e471fac5fde1462efb64f582d9080a6debe64f',
                         '.agents/skills/release-reviewer/VERSION': 'a66780da23103beaf12432b418508966b31a2a3a787f9468a5b6cdaa8667c1ef',
                         '.agents/skills/release-reviewer/agents/openai.yaml': '54dcc5409d56c8505df85a9dc63767c5001170acdfd07d42de3a0781786bb105',
                         '.agents/skills/release-reviewer/references/evidence-workflow.md': '76dd51c1b4b876fa8c4fdf29ceba884eb2c30e0a315c891530d966c4c6573824',
                         '.agents/skills/release-reviewer/references/group-review.md': '14d742125d915a130066231c715e3c7fa0834fd1fc85c596b0ef31312f9260fd',
                         '.agents/skills/release-reviewer/references/report-style.md': 'ff3d8c097a8f4d10cad7646156728c9e0adea1ef4aa86075cc63c457181d651a',
                         '.agents/skills/release-reviewer/references/resource-checks.md': 'e1e6be58112764ea321bf4ff9c1e19e9aed370507e77f7bf974f43a6cc5afd38',
                         '.agents/skills/release-reviewer/references/review-examples.md': '860b4464c668099da9b876b4f2011a52aa0d961f18916b7c2efd70ae27b2be16',
                         '.agents/skills/release-reviewer/references/review-rules.md': '194567763a2d75df6575ba007b5f5048b27e2830636be7e3549222a2b6f44a9d',
                         '.agents/skills/release-reviewer/references/runtime-controls.md': 'b4b74ff5ce210e3638f5f74970641500f29ef8efc72ead8269fc422c7f7f8953',
                         '.agents/skills/release-reviewer/references/session-workflow.md': '5bd96300ab6fa806101b534c4f5c2e97b20b785e16882f148206ceda7d040e07',
                         '.agents/skills/release-reviewer/scripts/chain_review.py': '40fe910d4c87c19e259e46fe63e33123a8bc9d7d0996eb1346ac28f84b522d88',
                         '.agents/skills/release-reviewer/scripts/coverage_policy.py': 'cc036e79496c88e018befceb407205d75b7cb4bafda71911af2959842982b2d1',
                         '.agents/skills/release-reviewer/scripts/evidence.py': '5fe9366fa52bfd17c17477001674f0575c732d4dc5a03a94a0e0e2ddc92dc34d',
                         '.agents/skills/release-reviewer/scripts/frozen_evidence.py': '8dae6dcdfdbe0570808ea1d9463d9ec226595c5fb6b655738eb4141e4db1ae8a',
                         '.agents/skills/release-reviewer/scripts/git_network_lease.py': '75542f73900c4039f273456a4f2cf02617ec33c3d839b96bee1dbad7af93a760',
                         '.agents/skills/release-reviewer/scripts/git_review_context.py': '5efbd08f682adf22b0d9712e51d384fd86faabc5dca9f4a59f59c6aa9efda973',
                         '.agents/skills/release-reviewer/scripts/git_support.py': '9732c261fdcb476a965753730421a73029b72c4fc6cb5b6e70bcf33a010acd5a',
                         '.agents/skills/release-reviewer/scripts/group_context.py': '0e8615cc5b32bccd742c687ec630e682882ad76cdc643d15fec83f500896a6b2',
                         '.agents/skills/release-reviewer/scripts/merge_parent_coverage.py': '0bd1c7201909e90a7a53c078e6b908cc9a08deaa1628c9943b44ace8f7dc48c5',
                         '.agents/skills/release-reviewer/scripts/release_report.py': '63e487a689d002cc3185f63095b9f31c786d55d6237591695299b5fdb64da3c4',
                         '.agents/skills/release-reviewer/scripts/resource_rules.py': '811edb5996bc6794c5ed1915000eab172b24f7953dfb106336e77149093af6f2',
                         '.agents/skills/release-reviewer/scripts/review_coordinator.py': '6ed42471507e2e2c3591576d565f67ac3ef65092f85e3b5bf00272c6c6d15edc',
                         '.agents/skills/release-reviewer/scripts/review_flow.py': 'd461fa14bc17f6bd1184b65d2290b1d9d5259510963876e215ba94efb450ce8f',
                         '.agents/skills/release-reviewer/scripts/review_runtime.py': '71957e980353e8a7d8fefdeb61e35c2f4349c309bc6d194d5aefbea47419e8d7',
                         '.agents/skills/release-reviewer/scripts/review_session.py': 'fa93f1327c658df7d354104d9e504665ac0b8a2594533b9f19d289aa4e9d4f6a',
                         '.agents/skills/release-reviewer/scripts/review_worklist.py': 'f997f898e737ae0e7132f1cea835dff0dafc43f31e4805394d6cc25b83243642'},
               'overlays': {},
               'payloadSha256': '66d0a66b37916f1b8e7c1631e574ec4dbe957f776f80a108126213dc8502eec5',
               'profile': 'repository',
               'profileHashes': {'group-instructions.md': '250823e9f060e6a51abfbe45aea06ca4819770f91def7a6bed6d1bfd7e94c9ae',
                                 'legacy-cleanup.md': 'cd9abd025fd748b71bfed3b1179834bac7a956280b62e7ff825810b0894e43ff',
                                 'profile.md': '6f53af6020c9135783509589b82339bec313d43bf6fa91a54973180bee4868bf'},
               'skills': ['codebase-wiki', 'merge-reviewer', 'output-style', 'release-reviewer'],
               'upstream': {'codebase-wiki': {'asset': 'codebase-llm-wiki-codex.zip',
                                              'repository': 'code-base-llm-wiki',
                                              'sha256': '6e953a391962ae2ba3e70072b22a9df1cc2cf7c6a2dd756ac8fab24ddbd8bd6f',
                                              'version': '0.6.4'},
                            'merge-reviewer': {'asset': 'merge-reviewer-0.19.0.zip',
                                               'repository': 'MergeReviewer',
                                               'sha256': '74fcd02ff44b7d3c6e7a7cbe50bcc17f17ff63a8ca3d6c922de53d2ab6d3c32e',
                                               'version': '0.19.0'},
                            'release-reviewer': {'asset': 'release-reviewer-0.8.0.zip',
                                                 'repository': 'ReleaseReviewer',
                                                 'sha256': 'b6ba140cd12db38fbe0ff2a43c142515197826b69891785f16e34e5012294a72',
                                                 'version': '0.8.0'}},
               'version': '0.32.0',
               'wikiFiles': {'.agents/skills/codebase-wiki/SKILL.md': 'bc1ae5a640047f825e0d7d1fc0f907de7df85c6b174cd0d6d13f314ca0811c1a',
                             '.agents/skills/codebase-wiki/VERSION': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e',
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
                             '.agents/skills/codebase-wiki/assets/entity-template.md': 'b38ff6dfce628990811d5081266a7a0a75163ce9645d812dcc6647e037cf9e19',
                             '.agents/skills/codebase-wiki/assets/functional-requirement-catalog-template.md': 'fc7d540a7813e8c0d0e333efece2cf38aa5441d6a8aee28b5e75bd8b57bee996',
                             '.agents/skills/codebase-wiki/assets/index-template.md': '9e3cda87423d6b864a1c6a3fc17d6c62c3496df83f3cb559af350cdbed1a2ab7',
                             '.agents/skills/codebase-wiki/assets/log-template.md': 'c972b51bd8960efbae76fd22b803c341f18ad5589eef336d828d1d37d531472e',
                             '.agents/skills/codebase-wiki/assets/module-template.md': 'c8ecb53971969c398acfdac05d2cf23a4604654099751022d094ecd10316e05f',
                             '.agents/skills/codebase-wiki/assets/notebooklm-ba-template.md': 'da51bf158b7bc5ef570e0b46769f0b4eae054f37b3cd35302120882caffe2fb6',
                             '.agents/skills/codebase-wiki/assets/notebooklm-sa-template.md': '502d11a4a0c6260cb6c544f2c139249ee28e962d02b13034108d20db82424934',
                             '.agents/skills/codebase-wiki/assets/notebooklm.toml': '1d890697300c48bdf5315598d601a4917be93d02d5ae1e4a222130c8886c15a6',
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
                             '.agents/skills/codebase-wiki/capabilities.json': '2339095ece6ea139a1a85329b587615f16bb86ca2f4636c3e61af1f9c67df1c9',
                             '.agents/skills/codebase-wiki/references/adr-workflow.md': '24c21d699fc1463c9a285fa5db1fa159a7d89b2b9f3277b52433ffb948a9644d',
                             '.agents/skills/codebase-wiki/references/analysis-document-standards.md': '3d3aa3b42cc18a29678dda813306d85450bb182570352ab6adc5af4047c98be8',
                             '.agents/skills/codebase-wiki/references/business-analysis-workflow.md': '79514a0051b33024e14d571e692b12b1fbb787db3cbf854f570f3611245a4d52',
                             '.agents/skills/codebase-wiki/references/code-archaeology-workflow.md': 'c511f7c9fe41bcbfb20255c5089f5808f1e524e9e5d0d52a0a5e2caca89e7b22',
                             '.agents/skills/codebase-wiki/references/code-audit-workflow.md': '8537f718ed14cfa8e733ec2022d34a9f5c6f54fab3cb0397c10108a47b87cf1e',
                             '.agents/skills/codebase-wiki/references/follow-up-actions.md': '5a2ba02d617b9564cdd3b086188984f0a28bfbcf05684108597eafa3afa70c82',
                             '.agents/skills/codebase-wiki/references/framework-maintenance.md': 'bbe3f935e423e8cb1dc709f1c5545683964e4788719237b8fe0238985931799d',
                             '.agents/skills/codebase-wiki/references/frontmatter-spec.md': 'bebaa7ed36e1bbccae6df6063ce1e6192b08940536b20d04fea5744aa617c334',
                             '.agents/skills/codebase-wiki/references/functional-exploration-workflow.md': '6b1a3264df09daa33df9335be9c142dfe355230d8b91ae75f2417722cbe587a9',
                             '.agents/skills/codebase-wiki/references/hooks-specification.md': '05a78a612556112b1ac98b4c22c638428ed5ae8323d8cdaed3c090f7de37d15e',
                             '.agents/skills/codebase-wiki/references/ingest-workflow.md': 'a8037cf056dbcce983329bb43d8005498c98e63aaa5298df16f7f9b4837a6cfc',
                             '.agents/skills/codebase-wiki/references/install-workflow.md': 'c1c32adbbd7abb85e26ad0d8d5df47e62b7e2cb611fc9db8d81e9f35363c20bb',
                             '.agents/skills/codebase-wiki/references/intent-routing.md': '0f6f5edd0cec513f9c4c097fb3cafebe7697bf45afab8217f4c4b66962945f0a',
                             '.agents/skills/codebase-wiki/references/lint-checklist.md': '6593186b1c0eace750576e3293f54e46ce2f324ffba1ad005f4859db297d253e',
                             '.agents/skills/codebase-wiki/references/log-operations.md': '4df32921aa21afde949026615d619d7122bebdcf55304989467f920d0bc2b990',
                             '.agents/skills/codebase-wiki/references/notebooklm-export-workflow.md': '5d950b688554e7302781388ec8a383c1e7ddee732926675401b05663ea862c69',
                             '.agents/skills/codebase-wiki/references/page-types.md': '1c2cbd240a7d1eb31b3eb8c1b3cdcfbc87b89e1fa3711c398a47a7f2cb120f82',
                             '.agents/skills/codebase-wiki/references/query-workflow.md': '3d449f609c21249258d70ecdb5c5f2ae80f359800016278dbcb3ebcf6c7886b8',
                             '.agents/skills/codebase-wiki/references/resource-safety.md': 'e67d365a8306c21389a0dc137240a64645237a268333f52ea640f6660964a1a8',
                             '.agents/skills/codebase-wiki/references/source-discovery-workflow.md': '2c8c158e24e2af487574060f4162159b0c41c9818b21770505012047fe94709e',
                             '.agents/skills/codebase-wiki/references/synthesis-workflow.md': '239f0cff242c8bed7357688bbc0205646f5e5ee8876afc224ced807dd6d2af7b',
                             '.agents/skills/codebase-wiki/references/system-analysis-workflow.md': 'e34d4bba47846b216dfcc3de824f3541316b70e8e608f8248a388370193f51ff',
                             '.agents/skills/codebase-wiki/references/system-design-workflow.md': 'f7e4713da8689dc5509b1febe772b26e76613cbcae81e6c4f94d8a059f9843d3',
                             '.agents/skills/codebase-wiki/scripts/bounded_process.py': '84feef0191e7e378eac207d8504aad69091aa78f2839a3f24fb155258b37dc4f',
                             '.agents/skills/codebase-wiki/scripts/check-dual-entry-sync.py': 'a2a57b8207e434da32af330f839e6643896ca4481887f1ad1cd7259a39def799',
                             '.agents/skills/codebase-wiki/scripts/check-stale.py': 'df5077d287ed3e396be63fa504e50f4d6d15280f4aa35ed06f3ecc2746a93014',
                             '.agents/skills/codebase-wiki/scripts/explore-functions.py': '7ead7198cb5ccbdebdfef8ba4b429728e54a94e3201ce751497d827c8d201284',
                             '.agents/skills/codebase-wiki/scripts/export-notebooklm.py': '481776008da5eefc5382604ac7022d51887f4491d2a9c8bc69ccec4f1d56a546',
                             '.agents/skills/codebase-wiki/scripts/frontmatter.py': 'ff5ca82b5129f058e7818ac8c42c79b4809a445b1977013631048f76be30cdae',
                             '.agents/skills/codebase-wiki/scripts/functional_inventory.py': '3d5774ce9a0031377ea7d8454f743d803bc42b895cfd7e2fb08d270703dbcb5b',
                             '.agents/skills/codebase-wiki/scripts/hooks/common.py': '5e1693b489112b833407975051b9830a10579763ceb18176b582a45eaee7bfcf',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-log-reminder.py': '0584845d838a85f3664ed11383b359a9c7ba5c70b7c5d7c56f26f13d18b86813',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-session-init.py': '07c99828b6e7ed6fc2dd36d7ad00264016bca61a94c636d06856e1aa89b98486',
                             '.agents/skills/codebase-wiki/scripts/hooks/wiki-write-guard.py': '5c0444c67b05e9ec5425c9e80927b6f056437ef03c4ab7537a840d33ee1602c8',
                             '.agents/skills/codebase-wiki/scripts/ingest-coverage.py': 'fee3b1f92ac266581f4bc0407a2d07e47956079ca4a7094481cd2d03b0d72f7e',
                             '.agents/skills/codebase-wiki/scripts/ingest_coverage.py': 'fcdb274c443211d146a288a5633b77f5928e292d06d0e0886b7743eef1f878cf',
                             '.agents/skills/codebase-wiki/scripts/install-framework.py': '26d3f2d968f40e15448f7276353d0ffa3d6cf4616e5510170bcb7b5a2bf8f508',
                             '.agents/skills/codebase-wiki/scripts/lint-wiki.py': '9da30fa633dced602106d66440b141843cb492d83f5dce9fc5cb16071734f4ba',
                             '.agents/skills/codebase-wiki/scripts/notebooklm_exporter.py': '7eed7c8c7e9405b7a81cfaf16e556a1b0dadd548b9825ed934291ae4eb5098b0',
                             '.agents/skills/codebase-wiki/scripts/offline-git.py': 'f43a6328e1b218b8d091088708b65977f248ff52cbbf5b2b583c083407ce5157',
                             '.agents/skills/codebase-wiki/scripts/offline_git.py': 'f96c33c8c1e94328a8cb9be8478c7a8a781b6a863a690399c07bdf419f56cd49',
                             '.agents/skills/codebase-wiki/scripts/parity-check.py': '0367b7ac6fb0070003369c7c6476a1816697e1339fa09e9f159545f01ac9d8b0',
                             '.agents/skills/codebase-wiki/scripts/project_scanner.py': '47f9551257028b918bb18fc6db98c85e2b54682561a650156f7a50870ad3d350',
                             '.agents/skills/codebase-wiki/scripts/rebuild-index.py': '77ced6490ed3a396ede128e82afbc867118d38ff962d36923bf3e61c4ee6e11b',
                             '.agents/skills/codebase-wiki/scripts/scan-project.py': 'd293f69509e0a0c85a89d642b9ca568f5e19d9fbb354068a3716c3a4f3db5a8f',
                             '.agents/skills/codebase-wiki/scripts/tgrep-search.py': '53b2e09b18cda940301dcdbd82b68f127939113861ef76a58903af7e75e10dd4',
                             '.agents/skills/codebase-wiki/scripts/validate-code-audit.py': '73623260a02163a52705bc93a3c6f69d9eb442eaa24824f56bdf2068abf4968f',
                             '.agents/skills/codebase-wiki/scripts/validate-frontmatter.py': '187ec3f53e5c74e2ccfb7b553f41be42d2c5ad9929114107b5309584355ebf27',
                             '.agents/skills/codebase-wiki/scripts/validate-log.py': 'cfd751e857d93a5bb91d8f9f058ce02069fb035f9e752142989e25001ff25fe1',
                             '.agents/skills/codebase-wiki/scripts/wiki-stats.py': '33453aadb08390378961dbe1b96368dcd9bf9caab7cc0ddbce38e5ecec820494',
                             '.agents/skills/codebase-wiki/scripts/wiki-write.py': 'e2375b8085f6138b0aaec378732a9dd5635bb16261d833d593e8d93fc8ef3186',
                             '.agents/skills/codebase-wiki/scripts/wiki_transaction.py': 'd07c242a65f933334d428b394eef9b3c5abbc839ee4449ada41f54c38cf4c67d'},
               'wikiInstalledVersionSha256': '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'}],
 'schema': 'gitlab-workspace-kit-predecessors/v1'}
SPECIAL_RULES = {'mergeRequestReview': 'branch-review-handoff-manual-comment',
 'releaseReview': 'entry-branches-diff-linked-local-heads-v3-single-repo-report',
 'sourceReferences': 'Repo/path'}


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
        fail(f"WorkflowKit 版本與安裝器 {expected_version} 不相容；請使用同一 Release 的 ZIP 與安裝器。")
    if manifest.get("workspaceContract") != WORKSPACE_CONTRACT:
        fail("組合包 workflow contract 與 GitLab Workspace 不相容。")
    expected_upstream = {
        key: {field: source[field] for field in ("repository", "asset", "version", "sha256")}
        for key, source in UPSTREAM.items()
    }
    if manifest.get("upstream") != expected_upstream:
        fail("組合包引用的上游 Skills 版本或 SHA-256 與此版安裝器的固定來源不符。")
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
    expected_outer = {manifest_path, f"{ROOT}/install.py", f"{ROOT}/README.md"} | {name for name in entries if name.startswith(f"{ROOT}/payload/") or name.startswith(f"{ROOT}/framework/") or name.startswith(f"{ROOT}/sources/") or name.startswith(f"{ROOT}/repository-payload/")}
    if set(entries) != expected_outer:
        fail("組合包包含不允許的額外檔案。")
    framework = {name[len(f"{ROOT}/framework/"):]: content for name, content in entries.items() if name.startswith(f"{ROOT}/framework/")}
    original_wiki = _read_pinned_zip(sources[UPSTREAM["codebase-wiki"]["asset"]], UPSTREAM["codebase-wiki"])
    if framework != original_wiki:
        fail("Codebase LLM Wiki framework 內容與固定 Release ZIP 不一致。")
    _verify_upstream_payload(payload, original_wiki, sources, skill_names, overlays)
    if manifest.get("profiles") != PROFILE_MANIFESTS or manifest.get("capabilities") != PROFILE_MANIFESTS["group"]["capabilities"]:
        fail("Workflow profile metadata differs from this release's reviewed profiles.")
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
    for source_id in ("merge-reviewer", "release-reviewer"):
        source = UPSTREAM[source_id]
        with zipfile.ZipFile(io.BytesIO(sources[source["asset"]])) as archive:
            for member in archive.infolist():
                name = safe_relative(member.filename.rstrip("/"))
                if member.is_dir():
                    continue
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

    upstream_skill_names = {PurePosixPath(name).parts[2] for name in all_upstream_paths if name.startswith('.agents/skills/')}
    kit_skill_files = {
        name: expected_digest
        for name, expected_digest in PROFILE_MANIFESTS["repository"]["files"].items()
        if name.startswith(".agents/skills/") and PurePosixPath(name).parts[2] not in upstream_skill_names
    }
    for relative, expected_digest in kit_skill_files.items():
        if relative not in payload or digest(payload[relative]) != expected_digest:
            fail(f"Kit Skill differs from the pinned common resource: {relative}")

    allowed_paths = {name for name in all_upstream_paths if name.startswith('.agents/skills/')} | added_paths | set(kit_skill_files)
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


def kit_gitignore(root: Path, skills: list[str], files: dict[str, str]) -> tuple[bytes, str, bytes | None]:
    """Merge only kit-owned paths into the workspace's existing ignore rules."""
    begin = "# BEGIN GitLab Workspace workflow kit"
    end = "# END GitLab Workspace workflow kit"
    paths = {"/.agents/skills/" + name + "/" for name in skills} | {
        "/.agents/gitlab-workspace-kit/", "/.gitlab-workspace/tool-installs/",
        "/" + MARKER, "/" + INSTALL_LOCK,
    }
    body = "\n".join(sorted(paths))
    target = assert_safe(root, ".gitignore", allow_missing=True)
    original = read_regular(target, FILE_LIMIT) if target.exists() else None
    try:
        text = (original or b"").decode("utf-8")
    except UnicodeDecodeError:
        fail(".gitignore must use UTF-8 so the installer can preserve existing rules.")
    starts = list(re.finditer(r"(?m)^(?:\ufeff)?(" + re.escape(begin) + r")\r?$", text))
    ends = list(re.finditer(r"(?m)^(" + re.escape(end) + r")\r?$", text))
    if ((starts or ends) and
            (len(starts) != 1 or len(ends) != 1 or ends[0].start() < starts[0].start())):
        fail(".gitignore contains an incomplete or duplicate GitLab Workspace block.")
    newline = "\r\n" if "\r\n" in text else "\n"
    block = begin + newline + body.replace("\n", newline) + newline + end
    if starts:
        start = starts[0].start(1)
        finish = ends[0].end(1)
        merged = text[:start] + block + text[finish:]
    else:
        separator = "" if not text or text.endswith(("\n", "\r", "\ufeff")) else newline
        merged = text + separator + block + newline
    content = merged.encode("utf-8")
    return content, digest(body.encode("utf-8")), original


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
    if bmad_files(raw) != legacy_bmad_identity(raw, selected):
        fail('Installed legacy BMAD marker identity differs from the reviewed package')
    return selected


def trusted_skill_files(raw: dict[str, Any]) -> dict[str, str]:
    return trusted_package(raw)["files"]




def bmad_files(raw: dict[str, Any] | None) -> dict[str, str]:
    return {p: h for p, h in (raw or {}).get('files', {}).items() if p.startswith('_bmad/')}








WIKI_INSTALLED_VERSION_SHA256 = '20c121886eb4f762044c6507745f6494525432ac22b41f5a73a8e5bf15b8b90e'


def external_bmad_path(value: str) -> bool:
    """BMAD belongs to its CLI for every current and historical kit transaction."""
    parts = str(value).replace('\\', '/').casefold().split('/')
    if parts[0] in ('_bmad', '_bmad-output'):
        return True
    return len(parts) >= 3 and parts[1] == 'skills' and parts[2].startswith('bmad-')


def reject_bmad_operations(operations: list[dict[str, Any]]) -> None:
    if any(isinstance(operation, dict) and external_bmad_path(operation.get('path', '')) for operation in operations):
        fail('This legacy transaction contains BMAD operations. Preserve its journal and use its original installer to resolve it before updating the kit.')


def legacy_bmad_identity(raw: dict[str, Any], reviewed: dict[str, Any]) -> dict[str, str]:
    """Authenticate historical marker bytes without inspecting external BMAD files."""
    expected = dict(reviewed.get('bmadFiles', {}))
    if not expected:
        return expected
    installed_root = raw.get('installedRoot')
    if not isinstance(installed_root, str) or not Path(installed_root).is_absolute():
        fail('Installed legacy BMAD root identity is missing')
    text = reviewed['bmadConfigTemplate']
    start = text.index('[core]') + len('[core]')
    end = text.find('\n[', start)
    end = len(text) if end < 0 else end
    block = re.sub(r'(?m)^project_name\s*=.*$', lambda _: 'project_name = ' + json.dumps(Path(installed_root).name, ensure_ascii=False), text[start:end])
    config = (text[:start] + block + text[end:]).encode('utf-8')
    reader = csv.DictReader(io.StringIO(reviewed['bmadFilesManifestTemplate']))
    rows = list(reader)
    for row in rows:
        if row['path'] == 'config.toml':
            row['hash'] = digest(config)
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=reader.fieldnames, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    expected.update({'_bmad/config.toml': digest(config), '_bmad/_config/files-manifest.csv': digest(output.getvalue().encode('utf-8'))})
    return expected


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
        wiki_expected = dict(trusted.get("wikiFiles", {}))
        if not isinstance(wiki_expected, dict) or not wiki_expected:
            fail("Reviewed predecessor Wiki fingerprints are missing.")
        if raw.get("profile", "group") == "group" and trusted.get("wikiInstalledVersionSha256"):
            wiki_expected[wiki_prefix + "VERSION"] = trusted["wikiInstalledVersionSha256"]
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
        if external_bmad_path(relative):
            continue
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
            if name in ("codebase-wiki", "merge-reviewer", "release-reviewer"):
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
        fail("偵測到舊版分開安裝或 Skill 本機修改；請依 workflow-kit 的 legacy-cleanup.md 人工清理列出的工具檔案。請保留 wiki/、docs/work/、review-reports/、其他個人資料及其他 Skills。路徑：" + ", ".join(old[:16]))














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
    reject_bmad_operations(operations)
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
            if operation.get("delete") and target.exists():
                fail(f"Recovery found a recreated retired path; preserving it: {relative.as_posix()}")
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


def transaction_paths(installed: dict[str, Any] | None = None,
                      previous: dict[str, Any] | None = None) -> set[str]:
    names = set(installed["skills"]) if installed else managed_skills()
    if previous:
        names.update(previous["skills"])
    return {".agents/skills/" + name for name in names if not name.casefold().startswith("bmad-")} | {
        ".agents/gitlab-workspace-kit", "Codex.md", ".codex/config.toml", ".codex/hooks.json",
        "AGENTS.md", "wiki", MARKER,
    } | ({".gitignore"} if (installed or {}).get("gitignoreBlockSha256") else set())


def validate_pending_recovery(root: Path, stage: Path, journal: dict[str, Any]) -> None:
    """Validate every interrupted operation before restoring any managed path."""
    installed = journal.get("installed_manifest")
    if (not isinstance(installed, dict) or journal.get("payloadSha256") != installed.get("payloadSha256")
            or journal.get("phase") not in ("prepared", "applying", "recovering")):
        fail("Pending transaction payload or phase differs.")
    trusted_skill_files(installed)
    if journal.get("previous_manifest") is not None:
        trusted_skill_files(journal["previous_manifest"])
    allowed = transaction_paths(installed, journal.get("previous_manifest"))
    retired = ({".agents/skills/" + name for name in journal.get("previous_manifest", {}).get("skills", [])}
               - {".agents/skills/" + name for name in installed["skills"]}) if journal.get("previous_manifest") else set()
    operations = journal.get("operations")
    if not isinstance(operations, list) or not operations:
        fail("Pending transaction operations missing.")
    reject_bmad_operations(operations)
    paths, backups = set(), set()
    for operation in operations:
        if not isinstance(operation, dict) or operation.get("kind") != "path":
            fail("Invalid pending transaction operation.")
        path, backup_name = operation.get("path"), operation.get("backup")
        if (not isinstance(path, str) or safe_relative(path).as_posix() != path
                or path not in allowed or path in paths
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
        deleting = operation.get("delete", False)
        if type(deleting) is not bool or deleting and (
                path not in retired or operation.get("newSha256") is not None
                or not operation["hadPrevious"] or incoming.exists()):
            fail("Pending transaction retirement identity differs.")
        if incoming.exists() and _action_hash(incoming) != operation.get("newSha256"):
            fail("Pending transaction incoming bytes changed.")
        if backup.exists():
            if not operation["hadPrevious"] or _action_hash(backup) != operation.get("expectedPreviousSha256"):
                fail("Pending transaction before-image changed.")
            if target.exists() and (deleting or _action_hash(target) not in {operation.get("newSha256")}):
                fail("Pending transaction target changed; preserving all files.")
        elif operation["hadPrevious"]:
            if (not target.exists() or _action_hash(target) != operation.get("expectedPreviousSha256")
                    or (not deleting and not incoming.exists() and journal.get("phase") != "recovering")):
                fail("Pending transaction original path changed or is missing.")
        elif target.exists() and (incoming.exists() or _action_hash(target) != operation.get("newSha256")):
            fail("Pending transaction new path changed; preserving all files.")
    if not (allowed - {"wiki"}).issubset(paths):
        fail("Pending transaction omits a bundle-managed path.")


def recover_incomplete(root: Path) -> None:
    _recover_incomplete_locked(root)


def _recover_incomplete_locked(root: Path) -> None:
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




def _apply_operations(root: Path, stage: Path, operations: list[dict[str, Any]], journal_path: Path, journal: dict[str, Any]) -> None:
    reject_bmad_operations(operations)
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
            source = assert_safe(stage, safe_relative(operation["incoming"]), allow_missing=operation.get("delete", False))
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
            if not operation.get("delete"):
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
            gitignore, gitignore_hash, gitignore_original = kit_gitignore(root, manifest["skills"], manifest["files"])
            if (old_manifest and old_manifest.get("profile", "group") == profile and
                    old_manifest.get("version") == expected_version and old_manifest.get("payloadSha256") == manifest["payloadSha256"] and
                    old_manifest.get("gitignoreBlockSha256") == gitignore_hash and gitignore == gitignore_original and
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
            (candidate_payload / ".gitignore").write_bytes(gitignore)
            installed_wiki_skill = candidate_payload / ".agents/skills/codebase-wiki"
            if installed_wiki_skill.exists():
                shutil.rmtree(installed_wiki_skill)
            # Native Wiki upgrades retain obsolete files by default. Retire only
            # the old kit-owned overlay files absent from this reviewed payload.
            for relative, old_hash in (old_manifest or {}).get("files", {}).items():
                if (relative.startswith(".agents/skills/codebase-wiki/")
                        and relative not in payload and not relative.endswith("/install-state.json")):
                    obsolete = assert_safe(native_target, relative, allow_missing=True)
                    if obsolete.exists():
                        if digest(read_regular(obsolete, FILE_LIMIT)) != old_hash:
                            fail(f"Retired Wiki overlay changed in staging: {relative}")
                        obsolete.unlink()
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
                if relative.startswith((".agents/skills/", ".agents/gitlab-workspace-kit/"))
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
                "gitignoreBlockSha256": gitignore_hash,
                "wikiInstallStateSha256": native_state_sha,
            }
            manifest_target = candidate_payload / "tool-manifest.json"
            _atomic_json(manifest_target, expected_installed)
            operations = build_operations(root, stage, candidate_payload, old_manifest, expected_installed,
                                          gitignore_previous_sha256=digest(gitignore_original) if gitignore_original is not None else None)
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
    with KitInstallLock(assert_safe(root, INSTALL_LOCK, allow_missing=True)):
        journal = json.loads(read_regular(journal_path).decode("utf-8"))
        owner = json.loads(read_regular(assert_safe(stage, "owner.json")).decode("utf-8"))
        if (owner != {"package": PACKAGE, "group_root": str(root)}
                or journal.get("schema") != "gitlab-workspace-kit-transaction/v1"
                or journal.get("group_root") != str(root) or journal.get("id") != stage.name
                or journal.get("phase") != "committed"
                or journal.get("payloadSha256") not in {profile["payloadSha256"] for profile in PROFILE_MANIFESTS.values()}):
            fail("Rollback transaction identity or reviewed payload differs.")
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
        reject_bmad_operations(operations)
        allowed = transaction_paths(current, previous)
        required = allowed - {"wiki"}
        retired = ({".agents/skills/" + name for name in previous["skills"]}
                   - {".agents/skills/" + name for name in current["skills"]}) if previous else set()
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
            deleting = operation.get("delete", False)
            if type(deleting) is not bool or deleting and (path not in retired or operation.get("newSha256") is not None):
                fail("Rollback retirement identity differs.")
            target = assert_safe(root, path, allow_missing=deleting)
            if (target.exists() if deleting else _action_hash(target) != operation.get("newSha256")):
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
                     installed: dict[str, Any], *, gitignore_previous_sha256: str | None) -> list[dict[str, Any]]:
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
    relative_paths += [(relative, relative) for relative in (".agents/gitlab-workspace-kit", "Codex.md", ".codex/config.toml", ".codex/hooks.json", "AGENTS.md", ".gitignore")]
    if (payload / "wiki").exists():
        relative_paths.append(("wiki", "wiki"))
    retired = sorted(name for name in old_skill_names - {skill.name for skill in new_skills} if not name.casefold().startswith("bmad-"))
    relative_paths += [(None, ".agents/skills/" + name) for name in retired]
    relative_paths.append(("tool-manifest.json", MARKER))
    for ordinal, (source_relative, relative) in enumerate(relative_paths):
        deleting = source_relative is None
        source_path = payload / source_relative if source_relative else None
        if source_path is not None and not source_path.exists():
            continue
        destination = assert_safe(root, relative, allow_missing=True)
        if relative == ".gitignore" and (
                destination.exists() != (gitignore_previous_sha256 is not None) or
                destination.exists() and _action_hash(destination) != gitignore_previous_sha256):
            fail(".gitignore changed during preflight; preserving it. Please retry installation.")
        bundle_owned = relative.startswith(".agents/skills/") or relative == ".agents/gitlab-workspace-kit"
        if destination.exists() and bundle_owned and not old_manifest:
            fail(f"A bundle-managed path already exists; refusing to overwrite it: {relative}")
        if relative == "wiki" and destination.exists():
            fail("Group/wiki appeared after preflight; preserving it and stopping the install.")
        incoming = f"incoming/{relative}"
        staged_input = stage / incoming
        staged_input.parent.mkdir(parents=True, exist_ok=True)
        if source_path is not None:
            os.replace(source_path, staged_input)
        previous_present = (gitignore_previous_sha256 is not None) if relative == ".gitignore" else destination.exists()
        operation: dict[str, Any] = {
            "kind": "path", "path": relative, "backup": f"backups/{ordinal:05d}",
            "incoming": incoming, "hadPrevious": previous_present,
            "expectedPreviousPresent": previous_present,
            "newSha256": None if deleting else _action_hash(staged_input),
        }
        if deleting:
            if not previous_present:
                fail(f"Retired managed Skill disappeared after verification: {relative}")
            owned = {name[len(relative) + 1:]: value for name, value in old_manifest["files"].items()
                     if name.startswith(relative + "/")}
            actual = hash_tree(root, destination)
            conflicts = sorted(name for name in actual.keys() | owned.keys() if actual.get(name) != owned.get(name))
            if conflicts:
                fail("Retired managed Skill contains modified or unowned files; preserving it: "
                     + ", ".join(relative + "/" + name for name in conflicts))
            operation["delete"] = True
            operation["expectedPreviousSha256"] = digest(json.dumps(
                owned, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        elif previous_present:
            operation["expectedPreviousSha256"] = gitignore_previous_sha256 if relative == ".gitignore" else _action_hash(destination)
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
    reviewed = trusted_package(raw)
    if reviewed and "capabilities" in reviewed:
        return list(reviewed["capabilities"])
    if raw.get("version") == VERSION and raw.get("payloadSha256") == PROFILE_MANIFESTS[profile]["payloadSha256"]:
        return PROFILE_MANIFESTS[profile]["capabilities"]
    capabilities = [c for c in PROFILE_MANIFESTS[profile]["capabilities"] if c != "functional-exploration"]
    if "release-reviewer" not in raw.get("skills", []):
        capabilities.remove("release-review")
    if "bmad-method" not in raw.get("upstream", {}):
        capabilities = [capability for capability in capabilities if capability != "bmad-workflow"]
    return capabilities




def inspect_status(root_value: Path, expected_version: str) -> dict[str, Any]:
    root = checked_root(root_value)
    try:
        # Status is strictly read-only: a crashed or concurrent transaction is
        # resolved only by an explicit installer operation under its lock.
        stage_parent = assert_safe(root, ".gitlab-workspace/tool-installs", allow_missing=True)
        if stage_parent.exists():
            if not stage_parent.is_dir():
                fail("套件安裝暫存路徑不是資料夾。")
            for stage in sorted(stage_parent.iterdir(), key=lambda item: item.name):
                if not stage.name.startswith("kit-"):
                    continue
                stage = stage_path(stage)
                if stage.is_symlink() or _is_reparse_point(stage, stage.lstat()) or not stage.is_dir() or not re.fullmatch(r"kit-[0-9a-f]{32}", stage.name):
                    fail("找到不安全的套件安裝暫存路徑；請人工檢查。")
                owner = json.loads(read_regular(assert_safe(stage, "owner.json")).decode("utf-8"))
                if owner != {"package": PACKAGE, "group_root": str(root)}:
                    fail("Transaction owner differs; preserving it.")
                journal_path = assert_safe(stage, "transaction.json", allow_missing=True)
                if not journal_path.exists():
                    fail("發現未完成的套件交易；請執行安裝或修復以處理。")
                journal = json.loads(read_regular(journal_path).decode("utf-8"))
                if journal.get("phase") != "committed":
                    reject_bmad_operations(journal.get("operations", []))
                if (journal.get("schema") != "gitlab-workspace-kit-transaction/v1" or journal.get("group_root") != str(root)
                        or journal.get("id") != stage.name or journal.get("phase") != "committed"):
                    fail("發現未完成或無法確認的套件交易；請執行安裝或修復以處理。")
        raw = _preflight_existing_workflow(root)
        if raw:
            profile = raw.get("profile", "group")
            metadata = {"version": raw["version"], "source": raw["source"], "profile": profile,
                        "workspaceContract": raw.get("workspaceContract"), "installerApi": 1,
                        "statusContract": 1, "integrity": "verified",
                        "upstreamVersions": {name: item["version"] for name, item in raw["upstream"].items()},
                        "capabilities": installed_capabilities(raw)}
            status = "installed" if (raw["version"] == expected_version and
                raw.get("payloadSha256") == PROFILE_MANIFESTS[profile]["payloadSha256"] and
                raw.get("local_update") is None) else "update-available"
            return {"ok": True, "status": status, **metadata}
        old = legacy_paths(root, include_installed=True)
        if old:
            return {"ok": True, "status": "needs-cleanup", "message": "請依組合包 cleanup 文件人工移除舊工具，保留 Wiki 與工作紀錄。", "legacyPaths": old[:24], "statusContract": 1, "integrity": "unknown"}
        return {"ok": True, "status": "missing", "statusContract": 1, "integrity": "missing"}
    except (KitError, OSError, ValueError, TypeError, KeyError) as error:
        return {"ok": True, "status": "error", "statusContract": 1, "integrity": "unverified", "message": str(error) or "組合包安裝記錄無法驗證。"}


def run():
    parser = argparse.ArgumentParser(description="Verify legacy WorkflowKit installations")
    parser.add_argument("action", choices=("status",))
    parser.add_argument("group_root", type=Path)
    parser.add_argument("--expected-version", default=VERSION)
    args = parser.parse_args()
    result = inspect_status(args.group_root, VERSION)
    if result.get("status") in ("installed", "update-available"):
        if result.get("workspaceContract") is None:
            result["workspaceContract"] = 1
        result.setdefault("installerApi", 1)
    print(json.dumps(result, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    raise SystemExit(run())
