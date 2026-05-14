# Dashboard

The dashboard is a static GitHub Pages site in `docs/`.

Enable it in GitHub:

```text
Settings -> Pages -> Deploy from branch -> main -> /docs
```

Expected URL:

```text
https://victor-wang-902.github.io/token_tracker/
```

After collecting new device data, rebuild the dashboard data file:

```bash
npm run collect -- --device YOUR_DEVICE_NAME
npm run dashboard
git add data/devices docs/data/ledger.json
git commit -m "update usage dashboard"
git push
```

The dashboard reads `docs/data/ledger.json`, which is generated from every JSON file in `data/devices/`.
