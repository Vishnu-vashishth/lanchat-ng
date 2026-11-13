import net from 'node:net';
export function dial(host, port, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ host, port });
        const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error('dial timeout'));
        }, timeoutMs);
        sock.once('connect', () => {
            clearTimeout(timer);
            sock.setNoDelay(true);
            resolve(sock);
        });
        sock.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
export function createServer(onConnection) {
    return net.createServer((sock) => {
        sock.setNoDelay(true);
        onConnection(sock);
    });
}
