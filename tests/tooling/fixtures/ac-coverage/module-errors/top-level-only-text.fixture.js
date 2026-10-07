// #102 第 3 轮 P2-1：模块顶层抛错，消息里恰好含 “.only”。这是模块收集错误，不是 only 注册，必须原样报出。
throw new Error('configuration for .only failed');
