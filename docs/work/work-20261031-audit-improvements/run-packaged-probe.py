"""Run an audit probe without changing the original audit evidence."""
from pathlib import Path
import argparse
import subprocess

root = Path(__file__).resolve().parents[3]
here = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('body', type=Path)
parser.add_argument('--artifact', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args, extra = parser.parse_known_args()
source = (root / 'scripts/validate-packaged-ui.mjs').read_text(encoding='utf-8')
prefix = source.split('\nawait mkdir(output, { recursive: true });', 1)[0]
args.output.mkdir(parents=True, exist_ok=True)
harness = args.output / 'harness.mjs'
harness.write_text(prefix + '\n' + args.body.read_text(encoding='utf-8'), encoding='utf-8')
command = ['node', str(harness), '--artifact', str(args.artifact), '--label', 'revision',
           '--output', str(args.output), *extra]
raise SystemExit(subprocess.call(command, cwd=root))
