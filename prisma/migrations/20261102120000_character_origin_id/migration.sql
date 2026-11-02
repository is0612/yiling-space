-- 角色卡的血缘标记：这个角色最初来自哪一份角色数据。
--
-- 导入永远是新建一行，新行有自己的 id。只认 id 的话，从另一台机器导回来的同一张卡
-- 就再也认不出「这是同一个她」，只能并排养出两个 —— 那正是「想合并数据」卡住的地方。
-- 导出时把来源角色 id 写进卡片（`origin.characterId`），导入后存在这一列；
-- 下次导出优先读它，血缘因此能跨多跳延续。
--
-- 为空 = 本机原生角色，或来自不带 origin 的老卡。

ALTER TABLE "characters" ADD COLUMN "originCharacterId" UUID;

CREATE INDEX "characters_originCharacterId_idx" ON "characters"("originCharacterId");
