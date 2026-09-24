// migrate-style.mjs — 历史一次性工具（把既有文档 <style> 同步为模板 brutal 版），已退役。
// S1 Task 5 起：简历样式唯一源 = themes/resume-classic.css，template.html 只含 <!--THEME-CSS--> 标记，
// 本脚本的护栏（模板裸 <style> 块 + BRUTAL-V1）在 marker-only 模板上永远不成立。
// 与其静默失效或误改文档，不如大声失败并指向 S1：样式调整直接改 themes/；
// 既有文档保留实际内联 CSS，其样式来源登记（legacy/styleHash）走 S1 迁移事务（T7），不经本脚本。
console.error('❌ migrate-style.mjs 已退役（S1）：简历样式唯一源为 themes/resume-classic.css，template.html 仅含 <!--THEME-CSS--> 标记。');
console.error('   本历史一次性工具不得在 marker-only 模板上运行。样式调整请直接修改 themes/；既有文档的样式登记见 S1 迁移（schemaVersion 事务，T7）。');
process.exit(1);
