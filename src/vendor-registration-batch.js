// Self-contained so the same controller can be embedded in the account page
// and exercised with fake wallets. This never handles a private key.
export function createVendorRegistrationBatch({ wallet, walletInfo = {}, api, journal, onUpdate = () => {},
  confirmFee = async () => false, now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), receiptAttempts = 40 }) {
  const address = /^0x[0-9a-fA-F]{40}$/;
  const hash = /^0x[0-9a-fA-F]{64}$/;
  const registry = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
  const isRabby = walletInfo?.rdns === "io.rabby" || wallet?.isRabby === true;
  let running = false, stopped = false;
  const checkpoint = () => { if (stopped) throw new Error("Batch paused. No further transaction will be sent."); };
  function validateInfo(info, v) {
    if (info.provider_id !== v.provider_id || Number(info.chain_id) !== 56) throw new Error("Unexpected Vendor or chain. Registration is BSC mainnet only.");
    if (info.transaction?.to?.toLowerCase() !== registry || BigInt(info.transaction.value ?? -1) !== 0n
      || !/^0xf2c298be[0-9a-fA-F]+$/.test(info.transaction.data || "")) throw new Error("Invalid registration transaction. No BNB transfer is permitted.");
  }
  async function checkWallet(owner) {
    checkpoint();
    const accounts = await wallet.request({ method: "eth_accounts" });
    if (accounts?.[0]?.toLowerCase() !== owner.toLowerCase()) throw new Error("Wallet account changed. Switch back to the selected owner and resume.");
    if (Number(await wallet.request({ method: "eth_chainId" })) !== 56) throw new Error("Wallet network changed. Switch to BNB Smart Chain and resume.");
    checkpoint();
  }
  async function confirm(v, owner, txHash, key, emit) {
    if (!hash.test(txHash || "")) throw new Error("A valid transaction hash is required to resume verification.");
    journal.set(key, { status: "submitted", tx_hash: txHash });
    for (let attempt = 0; attempt < receiptAttempts; attempt++) {
      checkpoint();
      emit("confirming", "Verifying registration receipt…", txHash);
      try {
        const result = await api(v.registration_endpoint, {tx_hash:txHash, owner_address:owner});
        const identity = result.identity;
        if (!identity?.agent_id || identity.owner_address?.toLowerCase() !== owner.toLowerCase()
          || identity.tx_hash?.toLowerCase() !== txHash.toLowerCase()) throw new Error("Registration receipt did not verify the selected owner and transaction.");
        journal.set(key, { status: "registered", tx_hash: txHash });
        emit("registered", "Registered Agent #" + identity.agent_id, txHash, identity.agent_id);
        return;
      } catch (error) {
        if (error.code !== "ERC8004_RECEIPT_NOT_FOUND") throw error;
        if (attempt + 1 < receiptAttempts) await sleep(3000);
      }
    }
    throw new Error("Receipt still pending. Resume to verify the same transaction; it will not be sent again.");
  }
  return {
    stop() { stopped = true; },
    async run(selected, owner, mode = "sponsored") {
      if (!["sponsored", "platform_paid"].includes(mode)) throw new Error("Unknown registration payment mode.");
      if (running) throw new Error("A registration batch is already running.");
      if (!address.test(owner || "")) throw new Error("Enter the full intended owner wallet address before starting.");
      const vendors = [...new Map(selected.map(v => [v.provider_id, v])).values()];
      if (!vendors.length || vendors.length > 5) throw new Error("Select between 1 and 5 distinct Vendors per batch.");
      for (const v of vendors) {
        if (!v.provider_id || v.registration_endpoint !== "/agent-router/erc8004/vendors/" + encodeURIComponent(v.provider_id) + "/registration") {
          throw new Error("Invalid Vendor registration endpoint.");
        }
      }
      if (!wallet?.request) throw new Error("Open this page in a browser with your EVM wallet unlocked.");
      running = true; stopped = false;
      try {
        if (!isRabby && mode === "sponsored") {
          const accounts = await wallet.request({method: "eth_requestAccounts"});
          if (accounts?.[0]?.toLowerCase() !== owner.toLowerCase()) throw new Error("Connected wallet does not match the selected owner. Switch wallets before starting.");
        }
        for (let index = 0; index < vendors.length; index++) {
          const v = vendors[index];
          const key = "ar-vendor-registration-v1:" + owner.toLowerCase() + ":56:" + v.provider_id;
          const emit = (status, message, txHash, agentId, errorCode) => onUpdate({provider_id:v.provider_id, index:index+1, total:vendors.length, status, message, tx_hash:txHash, agent_id:agentId, error_code:errorCode});
          try {
            checkpoint();
            emit("preparing", "Checking Vendor identity and sponsorship…");
            const info = await api(v.registration_endpoint);
            validateInfo(info, v);
            const transaction = {to:info.transaction.to, data:info.transaction.data, value:"0x0"};
            if (info.current_identity) {
              emit("already_registered", "Already registered as Agent #" + info.current_identity.agent_id, undefined, info.current_identity.agent_id);
              continue;
            }
            const previous = journal.get(key);
            if (v.recovery_hash || previous?.tx_hash) {
              await confirm(v, owner, v.recovery_hash || previous.tx_hash, key, emit);
              continue;
            }
            if (previous?.status === "submission_unknown") throw new Error("Submission outcome unknown. Enter its BscScan transaction hash to verify; do not register again.");
            if (mode === "platform_paid") {
              if (info.platform_paid?.available !== true || info.platform_paid.owner_address?.toLowerCase() !== owner.toLowerCase()) {
                throw new Error("Platform-paid registration requires the configured operator and the registered platform owner wallet. No Vendor-paid transaction is allowed.");
              }
              const accounts = await wallet.request({method:"eth_requestAccounts"});
              if (accounts?.[0]?.toLowerCase() !== owner.toLowerCase()) throw new Error("Connected wallet does not match the platform owner.");
              await wallet.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x38"}]});
              await checkWallet(owner);
              const estimate = BigInt(await wallet.request({method:"eth_estimateGas",params:[{from:owner,...transaction}]}));
              const gas = (estimate * 120n + 99n) / 100n;
              if (estimate <= 0n || gas > 500000n) throw new Error("Registration exceeds the 500,000 Gas safety limit.");
              const price = BigInt(await wallet.request({method:"eth_gasPrice"}));
              const maxFee = gas * price;
              if (price <= 0n || maxFee > 1000000000000000n) throw new Error("Invalid fee or registration exceeds the 0.001 BNB per-transaction safety limit.");
              const balance = BigInt(await wallet.request({method:"eth_getBalance",params:[owner,"pending"]}));
              if (balance < maxFee) throw new Error("Platform wallet has insufficient BNB for the estimated maximum fee.");
              const quotedAt = now();
              journal.set(key, {status:"ready"});
              emit("awaiting_fee_confirmation", "Review the BNB fee paid by the platform wallet. This is not Paymaster-sponsored.");
              if (await confirmFee({provider_id:v.provider_id,owner_address:owner,chain_id:56,
                registry_address:transaction.to,max_fee_wei:maxFee.toString(),gas:gas.toString(),gas_price_wei:price.toString()}) !== true) {
                throw new Error("Platform fee confirmation cancelled. No transaction was sent.");
              }
              await checkWallet(owner);
              if (now() - quotedAt > 60000) throw new Error("Fee quote expired. Start again to review a fresh estimate.");
              // The wallet signs AND sends this request. Persist uncertainty first,
              // and never resend after a timeout or unknown wallet error.
              journal.set(key, {status:"submission_unknown"});
              emit("awaiting_signature", "Confirm registration and the platform-paid BNB fee in your wallet. Do not increase the quoted fee limits.");
              let txHash;
              try {
                txHash = await wallet.request({method:"eth_sendTransaction",params:[{from:owner,...transaction,
                  gas:"0x"+gas.toString(16),gasPrice:"0x"+price.toString(16),chainId:"0x38"}]});
              } catch (error) {
                if (error?.code === 4001) {
                  journal.set(key,{status:"ready"});
                  throw new Error("Wallet confirmation cancelled. Batch paused; no automatic retry.");
                }
                throw new Error("Wallet submission outcome unknown. Check wallet activity and recover the transaction hash before retrying.");
              }
              await confirm(v, owner, txHash, key, emit);
              continue;
            }
            if (isRabby) throw Object.assign(new Error("Rabby cannot start a new registration through this raw-signing flow. AR needs a compatible sponsored registration path. Do not retry or export wallet secrets; no transaction was sent."), {code:"WALLET_SPONSORED_SIGNING_UNSUPPORTED"});
            if (!info.gas_sponsorship?.available || info.gas_sponsorship.endpoint !== v.registration_endpoint + "/paymaster") {
              throw new Error("Platform gas sponsorship is unavailable. No Vendor-paid transaction was sent.");
            }
            checkpoint();
            await wallet.request({method:"wallet_switchEthereumChain", params:[{chainId:"0x38"}]});
            await checkWallet(owner);
            const relay = body => api(info.gas_sponsorship.endpoint, body);
            const nonce = (await relay({method: "eth_getTransactionCount", params:[owner,"pending"]})).result;
            if (!/^0x[0-9a-fA-F]+$/.test(nonce || "")) throw new Error("Invalid transaction nonce from sponsorship service.");
            const gas = await wallet.request({method:"eth_estimateGas",params:[{from:owner,...transaction}]});
            if (BigInt(gas) <= 0n || BigInt(gas) > 500000n) throw new Error("Registration exceeds the 500,000 Gas safety limit.");
            const sponsorship = await relay({method:"pm_isSponsorable",params:[{from:owner,...transaction,gas}]});
            if (sponsorship.gas_sponsorship?.sponsored !== true) throw new Error("Platform sponsorship was declined. No BNB-paid fallback will be used.");
            await checkWallet(owner);
            // Fail before signing when browser persistence is unavailable.
            journal.set(key, {status:"ready"});
            emit("awaiting_signature", "Confirm this gas-free registration in your wallet.");
            let signed;
            try {
              signed = await wallet.request({method:"eth_signTransaction",params:[{
                from:owner,...transaction,gas,gasPrice:"0x0",nonce,chainId:"0x38"
              }]});
            } catch (error) {
              const originalCode = error?.code ?? error?.data?.originalError?.code ?? error?.cause?.code;
              const code = typeof originalCode === "number" && Number.isInteger(originalCode) ? originalCode : "WALLET_SIGNING_FAILED";
              const message = code === 4001 ? "Wallet confirmation cancelled. Batch paused."
                : code === 4100 ? "Wallet authorization is missing. Review the selected wallet's site connection."
                : code === -32002 ? "A wallet request is already pending. Complete or cancel it in the selected wallet."
                : [4200,-32601].includes(code) ? "The selected wallet or its RPC does not support eth_signTransaction."
                : "Wallet signing failed; this does not prove the signing method is unsupported.";
              throw Object.assign(new Error(message + " Code: " + code + ". No transaction or BNB-paid fallback was sent."), {code});
            }
            await checkWallet(owner);
            const raw = typeof signed === "string" ? signed : signed?.raw;
            if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(raw || "")) throw new Error("Wallet did not return a signed transaction.");
            // Persist BEFORE transmission. If the response is lost, or this tab
            // closes, never guess whether broadcasting succeeded and sign again.
            journal.set(key, {status:"submission_unknown"});
            emit("submitting", "Submitting through platform sponsorship…");
            checkpoint();
            const submission = await relay({method:"eth_sendRawTransaction",params:[raw]});
            await confirm(v, owner, submission.result, key, emit);
          } catch (error) {
            emit("paused", error.message || "Registration paused. Review before resuming.", undefined, undefined, error.code);
            return {status:"paused", provider_id:v.provider_id};
          }
        }
        return {status:"completed"};
      } finally { running = false; }
    }
  };
}
