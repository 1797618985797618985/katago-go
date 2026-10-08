# 实体电驱棋盘通信协议

本程序与实体棋盘控制器之间使用 **一行一个 JSON** 的文本协议，UTF-8 编码，`\n` 结尾。
选这个格式是因为单片机侧用 `ArduinoJson` 之类解析最简单，也方便用串口助手手工调试。

```
      PC（本程序）                       棋盘控制器（ESP32 / 树莓派 / …）
          │                                          │
          │  {"id":1,"cmd":"place",...}\n            │
          ├─────────────────────────────────────────►│
          │                                          │ 驱动电机取子 / 落子
          │  {"ack":1,"ok":true}\n                   │
          │◄─────────────────────────────────────────┤
          │                                          │
          │◄──── {"event":"button","x":15,"y":3} ────┤  实体棋盘按键落子
```

## 坐标约定

- `x`：从左到右，`0 … size-1`
- `y`：从上到下，`0 … size-1`
- 与程序内部、界面显示完全一致，不需要做任何翻转
- 控制器负责把它换算成自己的机械坐标（XY 滑台 / 极坐标 / 行列机构都行）

> 例：19 路棋盘的左上角是 `(0,0)`，右下角是 `(18,18)`。
> 围棋里的「星位 Q16」对应 `x=15, y=3`。

## PC → 控制器

所有指令都带一个自增的 `id`，控制器应在处理完成后用同样的 `id` 回 `ack`。

### reset —— 清空棋盘

```json
{"id":1,"cmd":"reset","size":19,"komi":7.5,"handicap":0,"mode":"pve"}
```

### place —— 落子（含本次提子）

```json
{"id":2,"cmd":"place","color":"B","x":15,"y":3,"capture":[[3,16],[3,17]],"moveNo":12}
```

| 字段 | 说明 |
| --- | --- |
| `color` | `"B"` 黑 / `"W"` 白 |
| `x`,`y` | 落子点 |
| `capture` | 这一手要**从棋盘上取走**的对方棋子坐标数组，可能为空 |
| `moveNo` | 手数，便于日志排查 |

控制器应当自行安排顺序（一般是先取子、再落子），并在全部机构动作完成后才回 `ack`。

### pass —— 停一手

```json
{"id":3,"cmd":"pass","color":"W","moveNo":13}
```

### sync —— 全盘对齐

```json
{"id":4,"cmd":"sync","size":19,"stones":[[15,3,"B"],[3,15,"W"]]}
```

用于**悔棋、复盘跳转、程序重启后恢复**等场景。控制器应把棋盘调整到与 `stones`
完全一致的状态（先清空再摆放是最简单的实现）。

### sync_last —— 只标出最后一手（可选）

```json
{"id":5,"cmd":"sync_last","color":"B","x":15,"y":3}
```

硬件有指示灯时，可以用来标记"刚下的一手"。

### end —— 对局结束

```json
{"id":6,"cmd":"end","winner":"B","text":"黑胜 3.5 目"}
```

`text` 可以直接送去显示屏或语音播报。

### led —— 提示点闪烁（可选）

```json
{"id":7,"cmd":"led","color":"B","x":15,"y":3,"mode":"blink"}
```

### ping —— 连通性测试

```json
{"id":8,"cmd":"ping"}
```

## 控制器 → PC

### ack —— 指令回执

```json
{"ack":1,"ok":true}
{"ack":2,"ok":false,"error":"取子机构卡住"}
```

超时（默认 8 秒，`hardware.options.ackTimeoutMs`）未收到 `ack` 时，程序会记录错误但继续运行，
不会卡住对局。

### button —— 实体棋盘落子

```json
{"event":"button","x":15,"y":3}
```

程序收到后会当作一次落子处理，等于用实体棋盘反向驱动界面。
坐标必须是棋盘上的合法点，否则会被规则引擎拒绝（并给出提示音）。

### ready / error —— 状态上报

```json
{"event":"ready","firmware":"1.0.3"}
{"event":"error","message":"X 轴限位开关未触发"}
```

## 配置

`config.json`：

```json
{
  "hardware": {
    "enabled": true,
    "driver": "tcp",
    "tcp": { "host": "192.168.1.50", "port": 9100, "reconnectMs": 3000 },
    "stdio": { "command": "python", "args": ["tools/serial_bridge.py"] },
    "options": { "interCommandDelayMs": 120, "ackTimeoutMs": 8000 }
  }
}
```

| 驱动 | 用途 |
| --- | --- |
| `none` | 关闭（默认） |
| `log` | 把指令按行写入 `engine/hardware.log`，**没有硬件时用它联调** |
| `tcp` | 连接控制器，断线自动重连 |
| `stdio` | 启动一个本机子进程（例如 Python + pyserial 脚本）通过管道通信 |

开发阶段建议先用 `log` 驱动把流程跑通，确认指令序列正确后再切到 `tcp`。

## 一个最小联调流程

1. 把 `driver` 设为 `log`，启动程序，在界面上下一盘棋；
2. 打开 `engine/hardware.log`，检查 `place` 指令里的 `capture` 是否和界面提子一致；
3. 运行 `node tools/mock-board.js` 启动一个模拟控制器（会打印收到的每条指令并回 `ack`）；
4. 切到 `tcp`，让控制器连上并先回一条 `{"event":"ready"}`；
5. 界面右下角「实体棋盘」区域会显示「已连接」，此时点「复位棋盘」应能看到机构动作。
