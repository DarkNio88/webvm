import "./wasm_exec.js";

import ipStackAwait from "./ipstack.js";

export const State = {
	NoState: 0,
	InUseOtherUser: 1,
	NeedsLogin: 2,
	NeedsMachineAuth: 3,
	Stopped: 4,
	Starting: 5,
	Running: 6,
};

export async function init() {
	const {IpStack} = await ipStackAwait();
	IpStack.init();

	const listeners = {
		onstateupdate: () => {},
		onnetmap: () => {},
		onloginurl: () => {},
	}

	let ipn = null;
	let localIp = null;
	let dnsIp = null;
	let ipMap = null;

	const lazyRunIpn = async (conf) => {
		const wasmUrl = new URL("tailscale.wasm", import.meta.url);
		const go = new self.Go();
		let {instance} = await fetch(wasmUrl).then(x => x.arrayBuffer()).then(x => WebAssembly.instantiate(x,go.importObject));
		go.run(instance);

		const persistentStateStorage = {
			setState(id, value) {
			window.localStorage[`ipn-state-${id}`] = value
			},
			getState(id) {
			return window.localStorage[`ipn-state-${id}`] || ""
			},
		}
		// Support both wasm variants: upstream arg shape (stateStorage in
		// the single config object) and the CDN 2-arg shape.
		const upstreamConf = Object.assign({}, conf, {
			controlURL: conf.controlUrl,
			controlUrl: conf.controlUrl,
			stateStorage: persistentStateStorage,
		});
		try
		{
			ipn = newIPN(upstreamConf, {stateStorage: persistentStateStorage});
		}
		catch(e)
		{
			ipn = newIPN(upstreamConf);
		}

		const setupIpStack = () => {
			ipn.tun.onmessage = function(ev) {
				IpStack.input(ev.data)
			};
			IpStack.output(function(p){
				ipn.tun.postMessage(p, [p.buffer]);
			});
		};
		setupIpStack();

		ipn.run({
			notifyState: (s) => {
				// Upstream wasm delivers the ipn State as a string
				// ("NoState"/"NeedsLogin"/...). Translate to the legacy
				// integer State so the LeaningTech client flow keeps
				// working.
				if (typeof s === "string") s = State[s] ?? s;
			console.log("tun: state ->", s);
				listeners.onstateupdate(s);
			},
			notifyNetMap: (s) => {
				const netMap = JSON.parse(s);
				listeners.onnetmap(netMap);
				const newLocalIp = netMap.self.addresses[0];
				if (localIp != newLocalIp)
				{
					localIp = newLocalIp;
					try{
						IpStack.up({localIp, dnsIp, ipMap});
					}catch(e){
						console.log(e);
						debugger;
					}
				}
			},
			notifyBrowseToURL: (l) => listeners.onloginurl(l),
		});

	};


	return {
		tcpSocket: IpStack.TCPSocket,
		udpSocket: IpStack.UDPSocket,
		parseIP: IpStack.parseIP,
		dumpIP: IpStack.dumpIP,
		resolve: IpStack.resolve,
		up: async (conf) => {
			if (ipn == null) {
				await lazyRunIpn(conf);
			}
			else
			{
				// Upstream newIPN has no up(): the backend is already
				// started by newIPN+run with the captured config.
				try { ipn.up?.(conf); } catch(e) {}
			}
			localIp = null;
			dnsIp = conf.dnsIp || "127.0.0.53";
			ipMap = conf.ipMap
		},
		down: () => {
			try { ipn.down?.(); } catch(e) {}
			IpStack.down();
		},
		login: () => ipn.login(),
		logout: () => ipn.logout(),
		listeners
	};
}

