import net from 'node:net';

// Create a connected pair of loopback TCP sockets for tests.
export function socketPair(): Promise<[net.Socket, net.Socket]> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const client = net.createConnection({ host: '127.0.0.1', port: addr.port });
      let serverSock: net.Socket | null = null;
      let clientReady = false;
      const done = () => {
        if (serverSock && clientReady) {
          server.close();
          resolve([client, serverSock]);
        }
      };
      server.once('connection', (s) => {
        serverSock = s;
        done();
      });
      client.once('connect', () => {
        clientReady = true;
        done();
      });
      client.once('error', reject);
    });
  });
}
