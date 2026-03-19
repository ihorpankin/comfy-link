import os
import sys
import importlib

# Add server package to path so bridge.py can be loaded
base_dir = os.path.dirname(os.path.abspath(__file__))
server_path = os.path.join(base_dir, "server")
if server_path not in sys.path:
    sys.path.append(server_path)

# Import and register nodes
from .nodes.receive_from_ps import ReceiveFromPS
from .nodes.send_to_ps import SendToPS

NODE_CLASS_MAPPINGS = {
    "ReceiveFromPS": ReceiveFromPS,
    "SendToPS": SendToPS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ReceiveFromPS": "Receive from Photoshop",
    "SendToPS": "Send to Photoshop",
}

# Bootstrap bridge server (registers HTTP/WS routes on import)
spec = importlib.util.spec_from_file_location("bridge", os.path.join(server_path, "bridge.py"))
bridge_module = importlib.util.module_from_spec(spec)
sys.modules["bridge"] = bridge_module  # Must be set before exec so internal imports resolve to the same instance
spec.loader.exec_module(bridge_module)

WEB_DIRECTORY = "js"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
