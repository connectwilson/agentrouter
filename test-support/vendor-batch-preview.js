// Local-only UI fixture. All wallet/RPC responses are fake; no upstream fetch,
// production credentials, valid signature, or blockchain transport exists here.
// Run: node test-support/vendor-batch-preview.js
import http from "node:http";
import { accountHtml } from "../src/home.js";
const owner = "0x0531bc53d9632E58dd08b54034824E2FdF68f1dB";
const registry = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const identities = new Map();
let sent = 0, verified = 0, signed = 0;
const mockWallet = `<script>
window.ethereum = { request: async ({method}) => {
  const mode = document.getElementById("fixture-mode")?.value;
  if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${owner}"];
  if (method === "eth_chainId") return "0x38";
  if (method === "wallet_switchEthereumChain") return null;
  if (method === "eth_estimateGas") return "0x186a0";
  if (method === "eth_signTransaction") {
    if (mode === "cancel") throw Object.assign(new Error("Cancelled"),{code:4001});
    if (mode === "unsupported") throw Object.assign(new Error("Unsupported"),{code:-32601});
    await fetch("/__fixture/sign",{method:"POST"}); return "0xabcd";
  }
  throw new Error("Fixture rejects unexpected wallet method: " + method);
} };
</script>`;
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,"http://localhost");
  const send = (data,status=200) => {res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data));};
  if (url.pathname === "/account") {
    const html = accountHtml({auth:{user:{name:"LOCAL MOCK WALLET"}}});
    res.writeHead(200,{"content-type":"text/html", "content-security-policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'"});
    return res.end(html.replace("</head>",mockWallet+"</head>").replace("<body data-agentrouter-app>",'<body data-agentrouter-app><div style="padding:16px;background:#543">LOCAL MOCK ONLY · No blockchain transactions <label>Scenario <select id="fixture-mode"><option value="success">Success</option><option value="cancel">Cancel signing</option><option value="unsupported">Unsupported wallet</option></select></label></div>'));
  }
  if (url.pathname === "/__fixture/sign") {signed++;return send({ok:true});}
  if (url.pathname === "/__fixture/state") return send({signed,sent,verified,identities:[...identities]});
  if (url.pathname === "/account/dashboard") return send({summary:{balance_credits:0,spent_credits_30d:0,successful_paid_calls:0,connected_agents:0},recent_activity:[],api_keys:[],top_services:[]});
  if (url.pathname === "/account/credits/deposit") return send({enabled:false});
  if (url.pathname === "/agent-router/erc8004/platform-registration") return send({chain_id:56,chain_name:"BNB Smart Chain",current_identity:{agent_id:"319032",owner_address:owner}});
  if (url.pathname === "/agent-router/erc8004/vendors") return send({vendors:["alpha","beta","gamma"].map(id=>({provider_id:id,title:"Fixture "+id,service_count:3,agent_id:identities.get(id)?.agent_id,registration_endpoint:"/agent-router/erc8004/vendors/"+id+"/registration"}))});
  const match = url.pathname.match(/^\/agent-router\/erc8004\/vendors\/(alpha|beta|gamma)\/registration(\/paymaster)?$/);
  if (match) {
    const id = match[1];
    if(req.method === "GET") return send({provider_id:id,chain_id:56,current_identity:identities.get(id),transaction:{to:registry,value:"0x0",data:"0xf2c298be00"},gas_sponsorship:{available:true,endpoint:url.pathname+"/paymaster"}});
    let raw="";for await(const chunk of req) raw+=chunk;
    const body=JSON.parse(raw);
    if (body.method === "eth_getTransactionCount") return send({result:"0x0"});
    if (body.method === "pm_isSponsorable") return send({gas_sponsorship:{sponsored:true}});
    if (body.method === "eth_sendRawTransaction") {sent++;return send({result:"0x"+String(sent).padStart(64,"0")});}
    if(body.tx_hash) {
      verified++;
      const identity={agent_id:String(900000+verified),owner_address:owner,tx_hash:body.tx_hash};
      identities.set(id,identity);return send({identity});
    }
  }
  return send({error:"Local fixture route not found"},404);
});
server.listen(0,"127.0.0.1",()=>console.log("Local mock: http://127.0.0.1:"+server.address().port+"/account"));
