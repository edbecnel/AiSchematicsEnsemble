import vm from "node:vm";
import http from "node:http";

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

const url = process.argv[2] || "http://127.0.0.1:3210/assets/onlineClient.js";
const js = await get(url);
console.log("status", js.status, "type", js.headers["content-type"]);

try {
  new vm.Script(js.body);
  console.log("OK: parses");
} catch (e) {
  console.error("PARSE-ERROR:", e?.message || String(e));
  process.exit(1);
}
