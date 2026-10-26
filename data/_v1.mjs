import { readFileSync } from 'node:fs';
const h = readFileSync('C:/Users/zhangyan/Documents/zz-agent-taskboard/exports/today.html', 'utf8');
const strip = s => s.replace(/<[^>]+>/g, '｜').replace(/｜+/g, '｜').replace(/[ \t]+/g, ' ').trim();
function seg(startKey, endKey) {
  const i = h.indexOf(startKey);
  if (i < 0) return `(未找到：${startKey})`;
  const j = endKey ? h.indexOf(endKey, i + startKey.length) : h.length;
  return strip(h.slice(i, j < 0 ? h.length : j)).slice(0, 1000);
}
console.log('=== 汇总卡 ===');
console.log(seg('<div class="sum', '<div class="sec">'));
console.log('\n=== 三问之二 ===');
console.log(seg('三问之二', '三问之三'));
console.log('\n=== 三问之三 ===');
console.log(seg('三问之三', '活动流'));
console.log('\n=== 会话执行看板 ===');
console.log(seg('会话执行看板', '</table>'));
