# XRT → Asset Hub

Minimal dapp for sending XRT from Robonomics (Polkadot) to Polkadot Asset Hub.

- connects to the Polkadot.js extension (Talisman / SubWallet work too);
- takes the amount in XRT and the recipient in any SS58 format or as a 0x public key;
- sends `xcmPallet.transferAssets` (XCM v5, teleport of the native asset, fees paid in XRT);
- checks that the recipient exists on Asset Hub, then waits until XRT is credited there.

## Run

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # static files in dist/
```

RPC endpoints can be overridden through `.env`:

```sh
VITE_ROBONOMICS_RPC=wss://...
VITE_ASSET_HUB_RPC=wss://...
```

## Notes

- On Asset Hub XRT is the foreign asset `{parents: 1, interior: X1(Parachain(3388))}` with `isSufficient = false`.
  The recipient account must already exist on Asset Hub (hold DOT). Otherwise the deposit fails and the XRT gets trapped.
  The UI blocks sending in that case.
- Asset Hub execution is paid out of the transferred XRT (it is swapped to DOT through the asset-conversion pool),
  about 0.0008 XRT per transfer. The recipient receives `amount − fee`.

## License

MIT, see [LICENSE](LICENSE).
