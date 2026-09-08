// EIP-6963 discovery is for explicit user selection, not proof of wallet trust.
// Never execute provider methods or fetch provider-supplied icons here.
export function createVendorWalletDiscovery({target, onChange = () => {}}) {
  const entries = [];
  const add = (provider, info) => {
    if (!provider || typeof provider.request !== "function" || typeof info?.name !== "string" || !info.name.trim()) return;
    const existing = entries.find(entry => entry.provider === provider);
    if (existing || entries.length >= 20) return;
    entries.push({id:String(entries.length + 1), provider, name:info.name.slice(0,80),
      rdns:typeof info.rdns === "string" ? info.rdns.slice(0,120) : ""});
    onChange(entries.slice());
  };
  const announce = event => add(event.detail?.provider, event.detail?.info);
  target.addEventListener("eip6963:announceProvider", announce);
  return {
    list: () => entries.slice(),
    get: id => entries.find(entry => entry.id === id),
    refresh() {
      target.dispatchEvent(new Event("eip6963:requestProvider"));
      if (!entries.length) add(target.ethereum, {name:target.ethereum?.isRabby ? "Rabby (legacy injection)" : "Browser wallet (legacy injection)",
        rdns:target.ethereum?.isRabby ? "io.rabby" : ""});
    },
    dispose() { target.removeEventListener("eip6963:announceProvider", announce); }
  };
}
