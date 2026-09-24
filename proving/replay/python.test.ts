import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  importedPaths,
  importersPython,
  importingPython,
  pinnedPython,
  topLevelModules,
} from "./python.mts";

describe("the release a Python repository pinned", () => {
  it("reads requirements files, locks and manifests", () => {
    expect(
      pinnedPython(
        [{ path: "requirements.txt", text: "Django==5.0\nstripe==11.4.0\n" }],
        "stripe",
      ),
    ).toBe("11.4.0");
    expect(
      pinnedPython(
        [
          {
            path: "poetry.lock",
            text: '[[package]]\nname = "stripe-mock"\nversion = "1.0"\n\n[[package]]\nname = "stripe"\nversion = "12.5.1"\n',
          },
        ],
        "stripe",
      ),
    ).toBe("12.5.1");
    expect(
      pinnedPython(
        [
          {
            path: "Pipfile.lock",
            text: JSON.stringify({ default: { pygithub: { version: "==1.59.1" } } }),
          },
        ],
        "PyGithub",
      ),
    ).toBe("1.59.1");
    expect(
      pinnedPython(
        [
          {
            path: "pyproject.toml",
            text: 'dependencies = [\n  "stripe (>=11.4.0,<12.0.0)",\n]\n',
          },
        ],
        "stripe",
      ),
    ).toBe("11.4.0");
    expect(
      pinnedPython(
        [
          {
            path: "pyproject.toml",
            text: '[tool.poetry.dependencies]\nslack_sdk = "^3.21"\n',
          },
        ],
        "slack-sdk",
      ),
    ).toBe("3.21");
  });

  it("prefers an exact pin, and the one in the major the bump names", () => {
    const files = [
      { path: "pyproject.toml", text: 'dependencies = ["openai>=0.27"]' },
      { path: "a/requirements.txt", text: "openai==0.28.1" },
      { path: "b/requirements.txt", text: "openai==1.3.5" },
    ];
    expect(pinnedPython(files, "openai")).toBe("0.28.1");
    expect(pinnedPython(files, "openai", "1.5.0")).toBe("1.3.5");
    // A lock's pin past the major named is what was installed.
    expect(
      pinnedPython(
        [
          { path: "pyproject.toml", text: 'dependencies = ["stripe>=10.12.0"]' },
          { path: "uv.lock", text: '[[package]]\nname = "stripe"\nversion = "11.6.0"\n' },
        ],
        "stripe",
        "10.12.0",
      ),
    ).toBe("11.6.0");
    // A frozen pin left behind in the old major loses to a range in the new one.
    expect(
      pinnedPython(
        [
          { path: "requirements.txt", text: "openai==0.27.10\n" },
          { path: "setup.cfg", text: "install_requires =\n    openai~=1.0\n" },
        ],
        "openai",
        "1.0",
      ),
    ).toBe("1.0");
  });

  it("does not take one package's pin for another's", () => {
    expect(
      pinnedPython([{ path: "requirements.txt", text: "stripe-mock==2.0\n" }], "stripe"),
    ).toBeUndefined();
  });
});

describe("what a wheel installs, and who imports it", () => {
  it("reads the modules at the top of site-packages", async () => {
    const site = await mkdtemp(join(tmpdir(), "site-"));
    try {
      await mkdir(join(site, "github"), { recursive: true });
      await writeFile(join(site, "github", "__init__.py"), "");
      await mkdir(join(site, "PyGithub-2.1.1.dist-info"), { recursive: true });
      await writeFile(join(site, "six.py"), "");
      expect(topLevelModules(site)).toEqual(["github", "six"]);

      const repo = join(site, "repo");
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, "a.py"), "import os\nfrom github import Github\n");
      await writeFile(join(repo, "b.py"), "import json, github.Repository as r\n");
      await writeFile(join(repo, "c.py"), "# import github\ngithubx = 1\n");
      expect(
        importingPython(repo, ["a.py", "b.py", "c.py"], ["github"]).map((path) =>
          path.slice(repo.length + 1),
        ),
      ).toEqual(["a.py", "b.py"]);
    } finally {
      await rm(site, { recursive: true, force: true });
    }
  });
});

describe("the consumer's own modules that use the SDK", () => {
  it("are followed to the files that import them and read a field that went", async () => {
    const repo = await mkdtemp(join(tmpdir(), "importers-"));
    try {
      const files: Record<string, string> = {
        "backend/app/services/billing/stripe_gateway.py": "import stripe\n",
        "backend/app/api/routes/billing.py":
          'from app.services.billing import errors, stripe_gateway\n\ndata.get("subscription")\n',
        "backend/app/api/routes/other.py":
          'from app.services.billing import errors\n\ndata.get("subscription")\n',
        "backend/app/services/billing/webhooks.py":
          'from .stripe_gateway import (\n    handle,\n)\n\nevent["subscription"]\n',
        "backend/app/services/billing/quiet.py": "from . import stripe_gateway\n",
      };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), text);
      }
      const gateway = join(repo, "backend/app/services/billing/stripe_gateway.py");
      expect(
        importersPython(repo, Object.keys(files), [gateway], ["subscription"]).map(
          (path) => path.slice(repo.length + 1),
        ),
      ).toEqual([
        "backend/app/api/routes/billing.py",
        "backend/app/services/billing/webhooks.py",
      ]);
      expect(
        importedPaths("pkg/sub/mod.py", "from ..other import x as y\nimport a.b, c\n"),
      ).toEqual(["pkg.other", "pkg.other.x", "a.b", "c"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
