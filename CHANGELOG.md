# Changelog

Changes against the original app, `live_adjustments` 0.9.3 (Engine Config) in
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), taken at commit `2c6cfdf`
(Merge PR #139). This repository's version numbers start at 10.10.0.

## 10.11.0

- **A refusal from the DME shows its code.** "Not available on this car" now reads "Not available on this car (NRC 31)"
  (the UDS negative response code), so the reason (unknown DID, wrong session, security access) can be read off the screen
  and not only from the app's log. This applies to MHD and MG Flasher alike.
- **The app's version is shown** in small grey text in the top-right corner of every page (`v10.11.0`). The Settings tab is
  drawn by the kit and has none.

## 10.10.0

### The app: `advokat_live_adjustments`

- **Installs beside the original.** The app id is `advokat_live_adjustments` (folder `apps/advokat_live_adjustments`), the
  tile is called "Advokat Engine Config", and the log id is `ADV0` (the original's is `OAA0`). Its settings and data are
  separate from the original's. The shared GPU renderer and controller gate serve both.
- **New tuning software: MG Flasher** (setting *Tuning software*, Custom Code 6.9 and later):
  - **Engine Map:** five slots (Map 1–5, MG Flasher's slots 0–4).
  - **Burbles:** six slots (0–5), one press picks one. BM3 keeps its aggression control.
  - **Max Cooling:** on and off.
  - The requests are the ones MG Flasher's Android app sends: `2E <DID hi> <DID lo> <value> <checksum>` with DIDs
    `0x6945` (map), `0x6946` (burbles) and `0x6947` (Max Cooling), accepted on `6E <DID>`, and asked again while the
    DME is busy (NRC `0x21`, up to 20 times).
  - **Writes only, not tried on a car.** The active slot and which slots are valid are read from RAM addresses that
    come from the Custom Code version's A2L and are not known, so the screen says *accepted*, never *confirmed*, and
    greys out no slot.
- **Tune code is generic.** `tune.js` (`TuneControl`) no longer branches per tuner: what a tune sends is a driver in the
  new `tuners.js`. MHD and MG Flasher are plain data (a spec of requests, how the DME's answer is accepted, optional
  identification and read-back); BM3 is a class. Adding a tune no longer means copying the control logic. The behaviour
  of BM3 and MHD is unchanged: the original's tests for both pass as they were.
- **Pages follow the tune:** Engine Map draws as many slots as the tune has (4 or 5), Burbles shows a slot picker for slot
  tunes, slots the DME does not offer are dimmed and refuse presses, and the "engine light may flash" note is shown for
  MHD only.
- **Safer presses:** a tune with an identification step sends nothing until the DME is identified, and a slot that is
  out of range or not offered is refused without sending.
- Description and *Tuning software* choices in `app.json` name MG Flasher; the README's tuned-DME section, "Adding a
  tune" and the test list are updated.
- Unchanged from the original: Exhaust Flap, Drive mode, the rpm guard, xDrive (experimental), xDrive live, BM3 and
  MHD behaviour, the diagnostic transport. Only two code comments in `diaglink.js` and `xdrive_live.js` no longer name
  apps that are not here.

### The repository

- **Only this app.** The other apps (Redline, M Vitals, eDrive, Live Data, ZF 8HP, Fault Scanner, Doom and the rest), their
  assets, tests and tools, the Doom engine source and the Korean, Russian and Chinese READMEs are removed. The original
  has them.
- **mgu Store source.** `mgu-repo.json` lists `apps/*` only. The original also required the GPU renderer
  (`idrive7-renderd` 2.1.7) and the controller gate (`mgu-inputgate` 1.0.0) and shipped them; this repository requires
  neither, so they must already be on the car. Add the repository to the Store as the branch `main`; the head unit
  builds the app, no catalog is published.
- **Build and tests.** `kit/tools/build.py` loses its special cases for the removed apps. The CI workflows are one kit
  test job (`app-tests.yml`) and `live-adjustments.yml`. `test_live_adjustments.js` gains MG Flasher cases (the real
  requests, busy retry, a refusing DME, plus a made-up-bytes spec for identification, read-back, valid slots and the
  engine rule).
- **README** rewritten for this app, with a disclaimer: use at your own risk, not made or endorsed by BMW.
