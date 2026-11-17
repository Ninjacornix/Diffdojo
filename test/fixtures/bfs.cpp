#include <iostream>
#include <vector>
#include <queue>

using namespace std;

// Returns the distance from `start` to every node (-1 if a node can't be reached)
vector<int> bfs(const vector<vector<int>>& adj, int start) {
    vector<int> dist(adj.size(), -1);
    queue<int> q;

    dist[start] = 0;
    q.push(start);

    while (!q.empty()) {
        int u = q.front();
        q.pop();
        cout << u << " ";                      // visit order

        for (int v : adj[u]) {
            if (dist[v] == -1) {                // not visited yet
                dist[v] = dist[u] + 1;
                q.push(v);
            }
        }
    }
    cout << "\n";
    return dist;
}

int main() {
    vector<vector<int>> adj = {{1, 2}, {0, 3}, {0, 3}, {1, 2}};
    vector<int> d = bfs(adj, 0);
    for (size_t i = 0; i < d.size(); i++) cout << i << ": " << d[i] << "\n";
    return 0;
}
