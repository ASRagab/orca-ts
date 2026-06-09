import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";

export interface FsTool {
  readText(path: string): Promise<Result<string, RuntimeError>>;
  writeText(path: string, content: string): Promise<Result<void, RuntimeError>>;
  exists(path: string): Promise<boolean>;
}

export function createFsTool(): FsTool {
  return {
    async readText(path) {
      try {
        return ok(await readFile(path, "utf8"));
      } catch (error) {
        return err({ _tag: "FileSystemError", path, message: String(error) });
      }
    },
    async writeText(path, content) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        return ok(undefined);
      } catch (error) {
        return err({ _tag: "FileSystemError", path, message: String(error) });
      }
    },
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    }
  };
}
