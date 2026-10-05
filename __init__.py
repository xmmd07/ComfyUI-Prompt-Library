"""ComfyUI-Prompt-Library · 第一阶段：Prompt Probe（只读探针）

纯前端插件：本文件只做一件事 —— 把 `web/` 目录登记为前端扩展目录。
不注册任何后端节点（NODE_CLASS_MAPPINGS 为空）、不注册任何 HTTP 路由、不读写任何用户数据。

阶段一结束后可直接删除整个 `custom_nodes/ComfyUI-Prompt-Library/` 目录完成卸载。
"""

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
