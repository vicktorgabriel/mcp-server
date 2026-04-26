#!/usr/bin/env python3
"""
MCP Client - Cliente Python para conectarse al servidor MCP

Uso:
    python3 client.py health
    python3 client.py list /
    python3 client.py read /archivo.txt
    python3 client.py write /archivo.txt "contenido"
"""

import requests
import json
import sys
import os
from pathlib import Path

class MCPClient:
    def __init__(self, base_url, api_key):
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.update({'X-API-Key': api_key})

    def _request(self, method, endpoint, **kwargs):
        url = f"{self.base_url}{endpoint}"
        try:
            response = self.session.request(method, url, **kwargs)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"❌ Error: {e}", file=sys.stderr)
            sys.exit(1)

    def health(self):
        return self._request('GET', '/health')

    def info(self):
        return self._request('GET', '/api/info')

    def list(self, path='/'):
        return self._request('GET', '/api/list', params={'path': path})

    def read(self, path):
        return self._request('GET', '/api/read', params={'path': path})

    def write(self, path, content):
        return self._request('POST', '/api/write', json={'path': path, 'content': content})

    def delete(self, path, recursive=False):
        return self._request('DELETE', '/api/delete', params={'path': path, 'recursive': recursive})

    def stat(self, path):
        return self._request('GET', '/api/stat', params={'path': path})

    def execute(self, command, args=None):
        return self._request('POST', '/api/execute', json={'command': command, 'args': args or []})


def main():
    mcp_host = os.getenv('MCP_HOST', 'http://localhost:3000')
    mcp_api_key = os.getenv('MCP_API_KEY', 'dev-key-change-me')

    if len(sys.argv) < 2:
        print("""
MCP Client v1.0.0 (Python)

Uso: python3 client.py <comando> [argumentos]

Comandos:
  health              Verificar conexión al servidor
  info                Información del servidor
  list <ruta>         Listar directorio
  read <ruta>         Leer archivo
  write <ruta> <texto> Escribir archivo
  delete <ruta>       Eliminar archivo/directorio
  stat <ruta>         Información del archivo

Ejemplos:
  python3 client.py health
  python3 client.py list /
  python3 client.py read /archivo.txt
  python3 client.py write /nuevo.txt "Hola mundo"

Variables de entorno:
  MCP_HOST            Host del servidor (default: http://localhost:3000)
  MCP_API_KEY         API Key para autenticación
        """)
        sys.exit(0)

    client = MCPClient(mcp_host, mcp_api_key)
    command = sys.argv[1]
    args = sys.argv[2:]

    try:
        if command == 'health':
            result = client.health()
        elif command == 'info':
            result = client.info()
        elif command == 'list':
            result = client.list(args[0] if args else '/')
        elif command == 'read':
            result = client.read(args[0])
        elif command == 'write':
            result = client.write(args[0], args[1])
        elif command == 'delete':
            result = client.delete(args[0], args[1] == 'true' if len(args) > 1 else False)
        elif command == 'stat':
            result = client.stat(args[0])
        else:
            print(f"❌ Comando desconocido: {command}")
            sys.exit(1)

        print(json.dumps(result, indent=2))
    except IndexError:
        print(f"❌ Argumentos insuficientes para: {command}")
        sys.exit(1)


if __name__ == '__main__':
    main()
