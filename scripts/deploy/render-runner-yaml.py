#!/usr/bin/env python3
"""Update runner+opencode container images in a Cloud Run service spec.

Reads the current runner spec on stdin (from `gcloud run services describe
runner --format=export`) and writes a new spec to stdout with both container
images bumped to the supplied tags.

Usage:
  gcloud run services describe runner --region=us-central1 --format=export \
    | python3 scripts/deploy/render-runner-yaml.py \
        --runner-image us-central1-docker.pkg.dev/PROJECT/REPO/runner:latest \
        --opencode-image us-central1-docker.pkg.dev/PROJECT/REPO/opencode:latest \
    > /tmp/runner-next.yaml
"""
import argparse
import sys

import yaml


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--runner-image", required=True)
    p.add_argument("--opencode-image", required=True)
    args = p.parse_args()

    spec = yaml.safe_load(sys.stdin)
    if not spec:
        print("error: empty input (runner service not found?)", file=sys.stderr)
        return 1

    containers = spec["spec"]["template"]["spec"]["containers"]
    bumped = {"runner": False, "opencode": False}
    for c in containers:
        if c["name"] == "runner":
            c["image"] = args.runner_image
            bumped["runner"] = True
        elif c["name"] == "opencode":
            c["image"] = args.opencode_image
            bumped["opencode"] = True

    if not all(bumped.values()):
        missing = [name for name, ok in bumped.items() if not ok]
        print(f"error: container(s) {missing} not found in runner spec", file=sys.stderr)
        return 1

    yaml.safe_dump(spec, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
