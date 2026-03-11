#!/usr/bin/env node

const DEFAULT_NAPCAT_URL = "http://127.0.0.1:3000";

function normalizeBaseUrl(input) {
  return String(input || DEFAULT_NAPCAT_URL).trim().replace(/\/+$/, "");
}

function normalizeKeyword(input) {
  return String(input || "").trim().toLowerCase();
}

function normalizeType(input) {
  const value = String(input || "all").trim().toLowerCase();
  if (value === "private" || value === "group") return value;
  return "all";
}

async function requestNapCatJson(baseUrl, pathName, token) {
  const headers = {};
  const normalizedToken = String(token || "").trim();
  if (normalizedToken) {
    headers.Authorization = `Bearer ${normalizedToken}`;
  }

  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `NapCat API ${pathName} failed: ${response.status} ${response.statusText}${body ? ` | ${body}` : ""}`,
    );
  }

  return await response.json();
}

function includesKeyword(value, keyword) {
  return String(value || "").toLowerCase().includes(keyword);
}

async function searchContacts(keyword, opts = {}) {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    throw new Error("keyword is required");
  }

  const targetType = normalizeType(opts.type);
  const baseUrl = normalizeBaseUrl(opts.napcatUrl || process.env.NAPCAT_URL);
  const token = String(opts.token || process.env.NAPCAT_TOKEN || "").trim();

  const shouldSearchFriends = targetType !== "group";
  const shouldSearchGroups = targetType !== "private";

  let friends = [];
  let groups = [];

  if (shouldSearchFriends) {
    const payload = await requestNapCatJson(baseUrl, "/get_friend_list", token);
    friends = Array.isArray(payload?.data) ? payload.data : [];
  }

  if (shouldSearchGroups) {
    try {
      const payload = await requestNapCatJson(baseUrl, "/get_group_list", token);
      groups = Array.isArray(payload?.data) ? payload.data : [];
    } catch (error) {
      console.warn(`[qq-contact-search] skip group search: ${error.message}`);
    }
  }

  const friendMatches = friends
    .filter((friend) =>
      includesKeyword(friend?.nickname, normalizedKeyword) ||
      includesKeyword(friend?.remark, normalizedKeyword),
    )
    .map((friend) => ({
      type: "private",
      name: friend?.remark || friend?.nickname || String(friend?.user_id || ""),
      id: String(friend?.user_id || ""),
      remark: friend?.remark || undefined,
      nickname: friend?.nickname || undefined,
    }))
    .filter((item) => item.id);

  const groupMatches = groups
    .filter((group) => includesKeyword(group?.group_name, normalizedKeyword))
    .map((group) => ({
      type: "group",
      name: group?.group_name || String(group?.group_id || ""),
      id: String(group?.group_id || ""),
      extra:
        typeof group?.member_count === "number" ? `${group.member_count}人` : undefined,
    }))
    .filter((item) => item.id);

  return [...friendMatches, ...groupMatches];
}

async function main() {
  const [, , keywordArg, typeArg = "all"] = process.argv;
  if (!keywordArg) {
    console.error("用法: node skill/napcat-qq/scripts/qq-contact-search.js <关键词> [private|group|all]");
    process.exitCode = 1;
    return;
  }

  try {
    const candidates = await searchContacts(keywordArg, { type: typeArg });
    process.stdout.write(`${JSON.stringify({ keyword: keywordArg, type: normalizeType(typeArg), candidates }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { searchContacts };
export default { searchContacts };
