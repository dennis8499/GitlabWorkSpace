"""Build an isolated local Git Group from the repository-scope evaluation fixture."""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "all-local-repos"
REPO_NAMES = ("admin-ui", "orders-api", "shared-contracts", "invoice-worker")
NESTED_REPO = Path("admin-ui") / "vendor" / "report-tool"


def run_git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()


def initialize_repo(repo: Path) -> None:
    subprocess.run(
        ["git", "init", "--quiet", "--initial-branch=main", str(repo)],
        check=True, capture_output=True, text=True,
    )
    run_git(repo, "add", "--all")
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=Megin Fixture",
         "-c", "user.email=megin-fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],
        check=True, capture_output=True, text=True,
    )


def create_group(destination: Path) -> Path:
    target = destination.resolve()
    if target.exists():
        raise FileExistsError(f"fixture destination already exists: {target}")
    target.mkdir(parents=True)
    source_repos = FIXTURE / "repos"
    for name in REPO_NAMES:
        shutil.copytree(source_repos / name, target / name)
    shutil.copytree(FIXTURE / "notes", target / "notes")

    initialize_repo(target / NESTED_REPO)
    for name in REPO_NAMES:
        initialize_repo(target / name)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new empty Group fixture directory")
    args = parser.parse_args()
    group = create_group(args.destination)
    print(group)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
