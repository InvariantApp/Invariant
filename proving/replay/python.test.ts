import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importingPython, pinnedPython, topLevelModules } from "./python.mts";

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
