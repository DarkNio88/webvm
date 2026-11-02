<script>
	import { networkData, startLogin, updateButtonData } from '$lib/network.js'
	import { createEventDispatcher } from 'svelte';
	import PanelButton from './PanelButton.svelte';
	var dispatch = createEventDispatcher();
	var connectionState = networkData.connectionState;
	var exitNode = networkData.exitNode;

	function handleConnect() {
		connectionState.set("DOWNLOADING");
		dispatch('connect');
	}

	function copyToClipboard(text) {
		window.navigator.clipboard.writeText(text);
	}

	let buttonData = null;
	$: buttonData = updateButtonData($connectionState, handleConnect);
</script>
<h1 class="text-lg font-bold">Networking</h1>
<PanelButton buttonImage="assets/tailscale.svg" clickUrl={buttonData.clickUrl} clickHandler={buttonData.clickHandler} rightClickHandler={buttonData.rightClickHandler} buttonTooltip={buttonData.buttonTooltip} buttonText={buttonData.buttonText}>
	{#if $connectionState == "CONNECTED"}
		<i class='fas fa-circle fa-xs ml-auto {$exitNode ? 'text-green-500' : 'text-amber-500'}' title={$exitNode ? 'Ready' : 'No exit node'}></i>
	{/if}
</PanelButton>
<p>WebVM can connect to the Internet via Tailscale</p>
<p>Using Tailscale is required since browser do not support TCP/UDP sockets (yet!)</p>
{#if $connectionState == "LOGINREADY" && networkData.loginUrl}
	<div class="bg-neutral-700 p-2 rounded-md">
		<p class="text-sm mb-2">Open this link and approve the node on the Headscale server:</p>
		<p class="break-all text-xs mb-2"><a class="underline" href={networkData.loginUrl} target="_blank" rel="noopener">{networkData.loginUrl}</a></p>
		<code class="block bg-neutral-800 p-2 rounded text-xs break-all">headscale auth register --auth-id {networkData.loginUrl.split('/register/')[1] || ''} --user USERNAME</code>
		<button class="mt-2 text-xs bg-neutral-600 hover:bg-neutral-500 p-1 rounded" on:click={() => copyToClipboard(networkData.loginUrl)}>Copy link</button>
	</div>
{/if}
{#if networkData.stateHelp && $connectionState != "CONNECTED" && $connectionState != "LOGINREADY"}
	<p class="text-xs">State: {$connectionState}</p>
{/if}
