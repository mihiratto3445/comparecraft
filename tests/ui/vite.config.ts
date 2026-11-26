import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { BackendClient } from "../../extensions/vscode/src/backend";
import type { FNode, FolderResult, Summary } from "../../src/api";

/** Folder status from its children, as the comparison engine computes it. */
function rollup(children: FNode[]): FNode["status"] {
  if (children.some((c) => c.status === "diff" || c.status === "left" || c.status === "right" || c.status === "error")) return "diff";
  return children.some((c) => c.status === "similar") ? "similar" : "same";
}

/** Newest change time below a node, per side, mirroring the engine's `newest_changes`. */
function newestChanges(node: FNode): [number | null, number | null] {
  const times: [number | null, number | null] = [null, null];
  const add = (side: 0 | 1 | null, time: number | null | undefined) => {
    if (side == null || time == null) return;
    const current = times[side];
    if (current == null || time > current) times[side] = time;
  };
  for (const child of node.children ?? []) {
    const [cl, cr] = newestChanges(child);
    add(0, cl);
    add(1, cr);
    if (child.dir) continue;
    if (child.status === "left") add(0, child.left?.modified);
    else if (child.status === "right") add(1, child.right?.modified);
    else if (child.status === "diff" && child.newer) add(child.newer === "left" ? 0 : 1, child[child.newer]?.modified);
  }
  return times;
}

/** Side holding the newest change below a node, per the engine's `content_newer`. */
function contentNewer(node: FNode): FNode["newer"] {
  const [l, r] = newestChanges(node);
  if (l != null && r != null) return l > r ? "left" : r > l ? "right" : undefined;
  return l != null ? "left" : r != null ? "right" : undefined;
}

async function folderResult(left: string, right: string, options: { dotNamesFirst?: boolean }): Promise<FolderResult> {
  const summary: Summary = { files: 0, same: 0, similar: 0, diff: 0, leftOnly: 0, rightOnly: 0, moved: 0, errors: 0 };
  const walk = async (rel: string): Promise<FNode[]> => {
    const names = [...new Set([...await readdir(join(left, rel)), ...await readdir(join(right, rel))])].sort();
    const nodes = await Promise.all(names.map(async (name): Promise<FNode> => {
      const path = rel ? `${rel}/${name}` : name;
      const [l, r] = await Promise.all([left, right].map(async (base) => {
        try { return await stat(join(base, path)); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      }));
      const dir = !!(l ?? r)?.isDirectory();
      const node: FNode = {
        name, rel: path.split(sep).join("/"), dir, status: "same",
        left: l ? { name, size: l.size, modified: l.mtimeMs } : undefined,
        right: r ? { name, size: r.size, modified: r.mtimeMs } : undefined,
      };
      if (dir) {
        node.children = l && r ? await walk(path) : undefined;
        node.status = !l ? "right" : !r ? "left" : rollup(node.children ?? []);
        node.newer = node.status === "diff" ? contentNewer(node) : undefined;
      } else {
        node.status = !l ? "right" : !r ? "left" : l.size === r.size && Math.abs(l.mtimeMs - r.mtimeMs) < 2000 ? "same" : "diff";
        node.newer = node.status === "diff" ? (l!.mtimeMs > r!.mtimeMs ? "left" : "right") : undefined;
        summary.files++;
        if (node.status === "left") summary.leftOnly++;
        else if (node.status === "right") summary.rightOnly++;
        else summary[node.status]++;
      }
      return node;
    }));
    const collator = new Intl.Collator("en", { ignorePunctuation: true, sensitivity: "base" });
    return nodes.sort((first, second) => Number(second.dir) - Number(first.dir)
      || (options.dotNamesFirst === false ? 0 : Number(second.name.startsWith(".")) - Number(first.name.startsWith(".")))
      || collator.compare(first.name, second.name));
  };
  const children = await walk("");
  return { root: { name: "", rel: "", dir: true, status: rollup(children), children }, summary };
}

export default defineConfig({
  plugins: [
    solid(),
    {
      name: "comparison-test-host",
      async configureServer(server) {
        const backend = await BackendClient.start(
          process.env.COMPARECRAFT_BACKEND ?? resolve(`src-tauri/target/debug/comparecraft-backend${process.platform === "win32" ? ".exe" : ""}`),
          { client: { name: "ui-tests", version: "0" }, log: (line) => console.error(line) },
        );
        server.httpServer?.once("close", () => void backend.dispose());
        server.middlewares.use("/test-fonts", (_request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(["A Font", "Example Mono", "Other Font"]));
        });
        server.middlewares.use("/test-invoke", async (request, response) => {
          try {
            let body = "";
            for await (const chunk of request) body += chunk;
            const { cmd, args = {} } = JSON.parse(body);
            const methods: Record<string, string> = {
              path_info: "path.info", load_text: "text.load", diff_texts: "text.diff", merge_texts: "text.merge",
              hex_align: "hex.align", compare_tables: "table.compare", pix_compare: "pix.compare", pix_image: "pix.image",
            };
            let result: unknown;
            if (cmd === "compare_folders") result = await folderResult(args.left, args.right, args.options ?? {});
            else if (cmd === "load_settings") result = {};
            else if (cmd === "list_sessions") result = [];
            else if (cmd === "find_session") result = null;
            else if (cmd === "save_session" || cmd === "save_settings") result = null;
            else if (cmd === "read_bytes") result = (await readFile(args.path)).subarray(args.offset, args.offset + args.len).toString("base64");
            else if (cmd === "read_data_url") {
              const data = await readFile(args.path);
              result = { url: `data:image/${extname(args.path).slice(1)};base64,${data.toString("base64")}`, size: data.length };
            } else if (cmd === "save_text") {
              await writeFile(args.path, args.lines.join("\n") + (args.finalNewline ? "\n" : ""));
              result = await backend.request("path.info", { path: args.path });
            } else if (methods[cmd]) result = await backend.request(methods[cmd], args);
            else throw new Error(`Unsupported test host command: ${cmd}`);
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(result));
          } catch (error) {
            response.statusCode = 500;
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 1430, strictPort: true },
});
