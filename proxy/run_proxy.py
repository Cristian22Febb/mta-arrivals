import os

import uvicorn


def main() -> None:
    host = os.getenv("PROXY_HOST", "127.0.0.1")
    port = int(os.getenv("PROXY_PORT", "8000"))
    uvicorn.run("nyctrains.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
