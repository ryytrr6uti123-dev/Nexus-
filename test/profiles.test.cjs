const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../profiles.cjs');

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-profiles-'));
  try {
    await run(new ProfileStore(path.join(directory, 'profiles.json')), directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('profile usernames are unique regardless of case and passwords are not stored in plain text', async () => {
  await withStore(async (store, directory) => {
    const created = await store.register('NexusUser', 'correct horse battery');
    await assert.rejects(store.register('nexususer', 'another secure password'), /already taken/);
    const accountId = await store.getAccountId(created.token);
    assert.ok(accountId);

    const persisted = await fs.readFile(path.join(directory, 'profiles.json'), 'utf8');
    assert.doesNotMatch(persisted, /correct horse battery/);
    assert.equal(created.profile.username, 'NexusUser');
    assert.equal((await store.getProfile(created.token)).username, 'NexusUser');
    await store.updateAccount(created.token, { username: 'NexusUser2' });
    assert.equal(await store.getAccountId(created.token), accountId);
    await store.logout(created.token);
    assert.equal(await store.getAccountId(created.token), null);
  });
});

test('profiles authenticate, persist activity and playlists, and allow account updates', async () => {
  await withStore(async (store, directory) => {
    const created = await store.register('music_fan', 'a sufficiently long password');
    const profile = await store.saveProfileData(created.token, {
      recentSearches: ['Kendrick Lamar'],
      recentGames: ['game-1'],
      favoriteGames: ['game-1'],
      recentMusic: [{
        id: '42',
        title: 'Sample',
        artist: 'Artist',
        previewUrl: 'https://audio-ssl.itunes.apple.com/sample.m4a',
      }],
      playlists: [{
        id: 'playlist-1',
        name: 'Favorites',
        tracks: [{
          id: '42',
          title: 'Sample',
          artist: 'Artist',
          trackUrl: 'https://music.apple.com/us/album/sample/42',
        }],
      }],
    });

    assert.deepEqual(profile.data.recentSearches, ['Kendrick Lamar']);
    assert.equal(profile.data.playlists[0].tracks[0].title, 'Sample');
    await store.updateAccount(created.token, { username: 'musicFan2' });
    await assert.rejects(store.login('music_fan', 'a sufficiently long password'), /Invalid username or password/);

    const reloaded = new ProfileStore(path.join(directory, 'profiles.json'));
    const restored = await reloaded.getProfile(created.token);
    assert.equal(restored.username, 'musicFan2');
    assert.deepEqual(restored.data.favoriteGames, ['game-1']);
    assert.equal((await reloaded.login('MUSICFAN2', 'a sufficiently long password')).profile.username, 'musicFan2');
  });
});
