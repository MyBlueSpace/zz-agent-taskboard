// zz-agent-taskboard 档 B 装配探针（2026-10-26 排查用，验证后删除）：
// 与桥同挂 insert 列表——若本探针加载成功而桥未生效，问题在桥自身；
// 若本探针也不加载，问题在 insert 装配/import 链路。
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";

export const name = "taskboard-probe";

export function apply() {
  try {
    appendFileSync(
      homedir() + "\\.dsh\\logs\\probe_plugin.log",
      new Date().toISOString() + " probe loaded\n"
    );
  } catch (e) {
    // 探针自身静默失败=记录到同目录备选文件
    try {
      appendFileSync(homedir() + "\\.dsh\\logs\\probe_plugin_err.log", String(e) + "\n");
    } catch {}
  }
}
