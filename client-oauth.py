#!/usr/bin/env python3
"""
MCP Client OAuth - Cliente mejorado con soporte OAuth2 y JWT
"""

import requests
import json
import sys
import os
from pathlib import Path

class MCPOAuthClient:
    def __init__(self, base_url, api_key=None, jwt_token=None):
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.jwt_token = jwt_token
        self.session = requests.Session()

    def _get_headers(self):
        headers = {'Content-Type': 'application/json'}
        
        if self.jwt_token:
            headers['Authorization'] = f'Bearer {self.jwt_token}'
        elif self.api_key:
            headers['X-API-Key'] = self.api_key
        
        return headers

    def _request(self, method, endpoint, data=None, **kwargs):
        url = f"{self.base_url}{endpoint}"
        headers = self._get_headers()
        
        try:
            response = requests.request(method, url, headers=headers, json=data, **kwargs)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"❌ Error: {e}", file=sys.stderr)
            try:
                print(f"Response: {e.response.json()}", file=sys.stderr)
            except:
                pass
            sys.exit(1)

    # ==================== OAuth ====================
    def register(self, username, email, password):
        return self._request('POST', '/auth/register', {
            'username': username,
            'email': email,
            'password': password
        })

    def login(self, username, password):
        result = self._request('POST', '/auth/login', {
            'username': username,
            'password': password
        })
        if result.get('token'):
            self.jwt_token = result['token']
        return result

    def refresh_token(self):
        result = self._request('POST', '/auth/refresh')
        if result.get('token'):
            self.jwt_token = result['token']
        return result

    def logout(self):
        return self._request('POST', '/auth/logout')

    def oauth_verify(self, provider, token, username=None):
        """Verificar token OAuth externo (Google, GitHub, etc)"""
        result = self._request('POST', '/auth/oauth-verify', {
            'provider': provider,
            'token': token,
            'username': username
        })
        if result.get('token'):
            self.jwt_token = result['token']
        return result

    # ==================== Archivos ====================
    def list(self, path='/'):
        return self._request('GET', '/api/list', params={'path': path})

    def read(self, path):
        return self._request('GET', '/api/read', params={'path': path})

    def write(self, path, content):
        return self._request('POST', '/api/write', {'path': path, 'content': content})

    def execute(self, command, args=None):
        return self._request('POST', '/api/execute', {
            'command': command,
            'args': args or []
        })

    def info(self):
        return self._request('GET', '/api/info')

    def health(self):
        # Health no requiere autenticación
        url = f"{self.base_url}/health"
        response = requests.get(url)
        return response.json()


def main():
    mcp_host = os.getenv('MCP_HOST', 'http://localhost:3000')
    mcp_api_key = os.getenv('MCP_API_KEY', None)
    mcp_jwt_token = os.getenv('MCP_JWT_TOKEN', None)

    if len(sys.argv) < 2:
        print("""
MCP Client OAuth v2.0

Uso: python3 client-oauth.py <comando> [argumentos]

Autenticación:
  register <username> <email> <password>  Registrar usuario
  login <username> <password>              Login
  oauth-verify <provider> <token> [username]  Verificar OAuth
  logout                                   Cerrar sesión
  refresh                                  Renovar token

Archivos:
  health                                   Verificar conexión
  info                                     Info del servidor
  list [ruta]                              Listar directorio
  read <ruta>                              Leer archivo
  write <ruta> <texto>                     Escribir archivo
  execute <comando> [args]                 Ejecutar comando

Ejemplos:
  python3 client-oauth.py register admin admin@test.com admin123
  python3 client-oauth.py login admin admin123
  python3 client-oauth.py list /
  python3 client-oauth.py read /archivo.txt

Variables de entorno:
  MCP_HOST        Host del servidor (default: http://localhost:3000)
  MCP_API_KEY     API Key para autenticación legacy
  MCP_JWT_TOKEN   JWT Token para autenticación OAuth
        """)
        sys.exit(0)

    client = MCPOAuthClient(mcp_host, mcp_api_key, mcp_jwt_token)
    command = sys.argv[1]
    args = sys.argv[2:]

    try:
        if command == 'health':
            result = client.health()
        elif command == 'info':
            result = client.info()
        elif command == 'register':
            if len(args) < 3:
                print("❌ Faltan argumentos: register <username> <email> <password>")
                sys.exit(1)
            result = client.register(args[0], args[1], args[2])
        elif command == 'login':
            if len(args) < 2:
                print("❌ Faltan argumentos: login <username> <password>")
                sys.exit(1)
            result = client.login(args[0], args[1])
            if result.get('token'):
                print(f"✅ Token: {result['token']}")
                print(f"💾 Guarda en MCP_JWT_TOKEN: export MCP_JWT_TOKEN='{result['token']}'")
        elif command == 'oauth-verify':
            if len(args) < 2:
                print("❌ Faltan argumentos: oauth-verify <provider> <token> [username]")
                sys.exit(1)
            result = client.oauth_verify(args[0], args[1], args[2] if len(args) > 2 else None)
            if result.get('token'):
                print(f"✅ Token: {result['token']}")
        elif command == 'logout':
            result = client.logout()
        elif command == 'refresh':
            result = client.refresh_token()
        elif command == 'list':
            result = client.list(args[0] if args else '/')
        elif command == 'read':
            result = client.read(args[0])
        elif command == 'write':
            result = client.write(args[0], args[1])
        elif command == 'execute':
            result = client.execute(args[0], args[1:] if len(args) > 1 else [])
        else:
            print(f"❌ Comando desconocido: {command}")
            sys.exit(1)

        print(json.dumps(result, indent=2))
    except IndexError:
        print(f"❌ Argumentos insuficientes para: {command}")
        sys.exit(1)


if __name__ == '__main__':
    main()
