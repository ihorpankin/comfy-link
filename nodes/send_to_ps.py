import asyncio
import base64
import threading
from io import BytesIO
import torch
import numpy as np
from PIL import Image


class SendToPS:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",)}}

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "PS Bridge"

    def execute(self, image):
        # Convert tensor to PIL Image
        # image shape: (batch, H, W, 3), values 0-1
        img_tensor = image[0]  # Take first image from batch
        img_array = (img_tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        pil_image = Image.fromarray(img_array, "RGB")

        h, w = img_array.shape[:2]

        # Encode as base64 PNG
        buffer = BytesIO()
        pil_image.save(buffer, format="PNG")
        image_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

        # Send to Photoshop via bridge WebSocket (async, scheduled on ComfyUI's event loop)
        def _send():
            try:
                import bridge
                future = asyncio.run_coroutine_threadsafe(
                    bridge.send_result_to_ps(image_base64, w, h), bridge._loop
                )
                future.result(timeout=10)
            except Exception as e:
                print(f"[PS Bridge] Error sending to PS: {e}")

        thread = threading.Thread(target=_send, daemon=True)
        thread.start()
        thread.join(timeout=10)

        return {}
