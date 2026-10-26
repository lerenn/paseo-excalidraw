/**
 * CI for a Paseo plugin: typecheck, test and build in a Node container.
 * Every function takes the repository root as `source`.
 */
import { dag, Container, Directory, object, func, argument } from "@dagger.io/dagger"

@object()
export class Ci {
  /** Node container with the repository mounted and dependencies installed. */
  @func()
  base(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Container {
    return dag
      .container()
      .from("node:22-slim")
      .withMountedCache("/root/.npm", dag.cacheVolume("npm"))
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["npm", "ci", "--no-audit", "--no-fund"])
  }

  /** Run `npm run typecheck`. */
  @func()
  async typecheck(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    return this.base(source).withExec(["npm", "run", "typecheck"]).stdout()
  }

  /** Run `npm test`. */
  @func()
  async test(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    return this.base(source).withExec(["npm", "test"]).stdout()
  }

  /** Run `npm run build`. */
  @func()
  async build(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    return this.base(source).withExec(["npm", "run", "build"]).stdout()
  }

  /** Real browser freehand drawing and PNG image-tool regression. */
  @func()
  async browser(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    const version = JSON.parse(await source.file("package.json").contents()).devDependencies.playwright
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Pin an exact Playwright version in package.json")
    const node = dag.container().from("node:22-slim")
    // Install browser/system dependencies before copying source, so code edits reuse this layer.
    return node
      .withMountedCache("/root/.npm", dag.cacheVolume("npm"))
      .withExec(["npx", "--yes", `playwright@${version}`, "install", "--with-deps", "chromium", "--only-shell"])
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["npm", "ci", "--no-audit", "--no-fund"])
      .withExec(["npm", "run", "test:browser"])
      .stdout()
  }

  /** Typecheck, test, build and browser smoke. Fails on the first failing step. */
  @func()
  async all(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    const out = [await this.typecheck(source), await this.test(source), await this.build(source), await this.browser(source)]
    return out.join("\n")
  }
}
