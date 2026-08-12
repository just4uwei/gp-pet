#!/bin/sh
# 等 combine-ofat-v2 跑完再开始，避免两个回测抢 CPU
while [ ! -f reports/folds/combine-ofat-v2.json ]; do sleep 10; done
sleep 8
pnpm backtest -- --codes "SH600000,SH600165,SH600329,SH600506,SH600654,SH600800,SH600979,SH601369,SH601998,SH603136,SH603298,SH603529,SH603759,SH603988,SH605599,SZ000001,SZ000526,SZ000691,SZ000863,SZ001218,SZ002001,SZ002116,SZ002227,SZ002342,SZ002456,SZ002572,SZ002687,SZ002812,SZ002928,SZ003816,SZ300001,SZ300171,SZ300341,SZ300508,SZ300669,SZ300835,SZ300997,SZ301175,SZ301366,SZ301717" --fixtures ./data/history --to 2025-06-30   --grid params/grid-regime.json --code-folds 4 --time-slices 3   --out reports/folds/regime.json > reports/folds/regime.log 2>&1
echo "EXIT=$?" >> reports/folds/regime.log
