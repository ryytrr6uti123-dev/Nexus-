const profileDataKey = 'nexus-profile-data';
let activeProfile = null;
let profileData = loadGuestProfileData();
let profileSaveTimer = null;
let profileSaveQueue = Promise.resolve();
let selectedMusicTrack = null;
let selectedPlaylistId = null;

function emptyProfileData() {
    return {
        recentSearches: [],
        recentGames: [],
        favoriteGames: [],
        recentMusic: [],
        playlists: [],
    };
}

function loadGuestProfileData() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(profileDataKey) || '{}');
    } catch (error) {
        console.warn('Could not read the saved guest profile.', error);
    }

    const savedRecentGames = Array.isArray(saved.recentGames) ? saved.recentGames : recentGameIds;
    const savedFavorites = Array.isArray(saved.favoriteGames) ? saved.favoriteGames : [...favoriteGameIds];
    return {
        recentSearches: Array.isArray(saved.recentSearches)
            ? [...new Set(saved.recentSearches.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 50)
            : [],
        recentGames: [...new Set(savedRecentGames.filter(id => typeof id === 'string'))].slice(0, 100),
        favoriteGames: [...new Set(savedFavorites.filter(id => typeof id === 'string'))].slice(-500),
        recentMusic: Array.isArray(saved.recentMusic) ? saved.recentMusic.slice(0, 50) : [],
        playlists: Array.isArray(saved.playlists) ? saved.playlists.slice(0, 50) : [],
    };
}

function showProfileMessage(message, isError = false) {
    const label = document.getElementById('profile-message');
    label.textContent = message;
    label.className = `mb-3 text-xs ${isError ? 'text-rose-300' : 'text-slate-400'}`;
}

function updateProfileWidget() {
    const avatar = document.getElementById('profile-avatar-text');
    const blankIcon = document.getElementById('profile-blank-icon');
    const button = document.getElementById('profile-button');
    if (!activeProfile) {
        blankIcon.classList.remove('hidden');
        avatar.classList.add('hidden');
        button.setAttribute('aria-label', 'Open guest profile');
        return;
    }
    blankIcon.classList.add('hidden');
    avatar.classList.remove('hidden');
    avatar.textContent = activeProfile.username.slice(0, 2).toUpperCase();
    button.setAttribute('aria-label', `Open profile for ${activeProfile.username}`);
}

function renderProfileActivity() {
    const activity = document.getElementById('profile-activity');
    if (!activity) return;
    activity.replaceChildren();

    const sections = [
        ['Recent searches', profileData.recentSearches],
        ['Recently played games', profileData.recentGames.map(id => gamesById.get(id)?.title || id)],
        ['Favorite games', profileData.favoriteGames.map(id => gamesById.get(id)?.title || id)],
        ['Recent music', profileData.recentMusic.map(track => `${track.title} · ${track.artist}`)],
        ['Playlists', profileData.playlists.map(playlist => `${playlist.name} · ${playlist.tracks.length} songs`)],
    ];
    for (const [label, items] of sections) {
        const details = document.createElement('details');
        details.className = 'rounded-lg border border-white/[0.07] px-2 py-1.5';
        const summary = document.createElement('summary');
        summary.className = 'flex cursor-pointer list-none justify-between gap-2 text-[11px] text-slate-300';
        const title = document.createElement('span');
        title.textContent = label;
        const count = document.createElement('span');
        count.className = 'text-slate-500';
        count.textContent = String(items.length);
        summary.append(title, count);
        details.append(summary);

        if (items.length) {
            const list = document.createElement('ul');
            list.className = 'mt-1 space-y-1 border-t border-white/[0.06] pt-1.5 text-[10px] text-slate-400';
            for (const value of items.slice(0, 10)) {
                const item = document.createElement('li');
                item.className = 'truncate';
                item.textContent = value;
                list.append(item);
            }
            details.append(list);
        } else {
            const empty = document.createElement('p');
            empty.className = 'mt-1 border-t border-white/[0.06] pt-1.5 text-[10px] text-slate-500';
            empty.textContent = 'Nothing saved yet.';
            details.append(empty);
        }
        activity.append(details);
    }
}

function persistProfileData() {
    if (!activeProfile) {
        try {
            localStorage.setItem(profileDataKey, JSON.stringify(profileData));
        } catch (error) {
            console.error('Could not save guest profile activity.', error);
            showToast('Could not save your activity on this device.');
        }
        renderProfileActivity();
        renderMusicLibrary();
        return;
    }

    clearTimeout(profileSaveTimer);
    profileSaveTimer = setTimeout(() => {
        profileSaveQueue = profileSaveQueue.catch(() => {}).then(async () => {
            if (!activeProfile) return;
            await requestProfile('/data', 'PUT', { data: profileData });
            document.getElementById('music-sync-status').textContent = 'Synced to your Nexus profile';
        });
        profileSaveQueue.catch(error => {
            console.error('Could not sync profile activity.', error);
            document.getElementById('music-sync-status').textContent = 'Profile sync failed';
            showProfileMessage(error.message, true);
        });
    }, 500);
    renderProfileActivity();
    renderMusicLibrary();
}

function recordRecentSearch(value) {
    const query = typeof value === 'string' ? value.trim().slice(0, 200) : '';
    if (!query) return;
    profileData.recentSearches = [
        query,
        ...profileData.recentSearches.filter(item => item.toLocaleLowerCase() !== query.toLocaleLowerCase()),
    ].slice(0, 50);
    persistProfileData();
}

function mergeProfileData(primary, extra) {
    const merged = emptyProfileData();
    merged.recentSearches = [...new Set([
        ...(primary.recentSearches || []),
        ...(extra.recentSearches || []),
    ])].slice(0, 50);
    merged.recentGames = [...new Set([
        ...(primary.recentGames || []),
        ...(extra.recentGames || []),
    ])].slice(0, 100);
    merged.favoriteGames = [...new Set([
        ...(primary.favoriteGames || []),
        ...(extra.favoriteGames || []),
    ])].slice(-500);
    merged.recentMusic = [...(primary.recentMusic || []), ...(extra.recentMusic || [])]
        .filter((track, index, list) => list.findIndex(item => item.id === track.id) === index)
        .slice(0, 50);
    merged.playlists = [...(primary.playlists || []), ...(extra.playlists || [])]
        .filter((playlist, index, list) => list.findIndex(item => item.id === playlist.id) === index)
        .slice(0, 50);
    return merged;
}

function applyProfile(profile, mergeGuestActivity = false) {
    if (profile && !activeProfile) {
        try {
            localStorage.setItem(profileDataKey, JSON.stringify(profileData));
        } catch (error) {
            console.error('Could not preserve guest profile activity.', error);
        }
    }
    activeProfile = profile;
    if (profile) {
        profileData = mergeGuestActivity
            ? mergeProfileData(profile.data || emptyProfileData(), loadGuestProfileData())
            : { ...emptyProfileData(), ...(profile.data || {}) };
        recentGameIds = profileData.recentGames.slice(0, 100);
        favoriteGameIds = new Set(profileData.favoriteGames.slice(-500));
        document.getElementById('profile-guest').classList.add('hidden');
        document.getElementById('profile-account').classList.remove('hidden');
        document.getElementById('profile-display-name').textContent = `Signed in as ${profile.username}`;
        document.getElementById('profile-new-username').value = '';
        document.getElementById('profile-new-password').value = '';
        document.getElementById('music-sync-status').textContent = 'Synced to your Nexus profile';
        updateProfileWidget();
        renderGameLibrary();
        renderMusicLibrary();
        renderProfileActivity();
        if (mergeGuestActivity) persistProfileData();
        return;
    }

    activeProfile = null;
    profileData = loadGuestProfileData();
    recentGameIds = profileData.recentGames.slice(0, 100);
    favoriteGameIds = new Set(profileData.favoriteGames.slice(-500));
    document.getElementById('profile-account').classList.add('hidden');
    document.getElementById('profile-guest').classList.remove('hidden');
    document.getElementById('music-sync-status').textContent = 'Guest playlists save on this device';
    showProfileMessage('Guest profile · saved on this device');
    updateProfileWidget();
    renderGameLibrary();
    renderMusicLibrary();
    renderProfileActivity();
}

function openProfilePanel() {
    const panel = document.getElementById('profile-panel');
    const button = document.getElementById('profile-button');
    panel.classList.toggle('hidden');
    const isOpen = !panel.classList.contains('hidden');
    button.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && !activeProfile) document.getElementById('profile-username').focus();
}

function closeProfilePanel() {
    document.getElementById('profile-panel').classList.add('hidden');
    document.getElementById('profile-button').setAttribute('aria-expanded', 'false');
}

async function authenticateProfile(route) {
    const username = document.getElementById('profile-username').value.trim();
    const password = document.getElementById('profile-password').value;
    if (!username || !password) {
        showProfileMessage('Enter both a username and password.', true);
        return;
    }
    const buttons = [
        document.getElementById('profile-register'),
        document.getElementById('profile-login'),
    ];
    buttons.forEach(button => { button.disabled = true; });
    try {
        const response = await requestProfile(route, 'POST', { username, password });
        document.getElementById('profile-password').value = '';
        applyProfile(response.profile, route === '/register');
        showProfileMessage(`Signed in as ${response.profile.username}.`);
        if (route === '/register') persistProfileData();
    } catch (error) {
        showProfileMessage(error.message, true);
    } finally {
        buttons.forEach(button => { button.disabled = false; });
    }
}

async function initializeProfile() {
    document.getElementById('profile-button').addEventListener('click', openProfilePanel);
    document.getElementById('profile-close').addEventListener('click', closeProfilePanel);
    document.getElementById('profile-register').addEventListener('click', () => authenticateProfile('/register'));
    document.getElementById('profile-login').addEventListener('click', () => authenticateProfile('/login'));
    document.getElementById('profile-update').addEventListener('click', async () => {
        const username = document.getElementById('profile-new-username').value.trim();
        const password = document.getElementById('profile-new-password').value;
        try {
            const response = await requestProfile('/account', 'PATCH', {
                ...(username ? { username } : {}),
                ...(password ? { password } : {}),
            });
            activeProfile = response.profile;
            updateProfileWidget();
            document.getElementById('profile-display-name').textContent = `Signed in as ${activeProfile.username}`;
            document.getElementById('profile-new-username').value = '';
            document.getElementById('profile-new-password').value = '';
            showProfileMessage('Profile updated.');
        } catch (error) {
            showProfileMessage(error.message, true);
        }
    });
    document.getElementById('profile-logout').addEventListener('click', async () => {
        try {
            await requestProfile('/logout', 'POST');
            applyProfile(null);
            showProfileMessage('Signed out. Guest activity is saved on this device.');
        } catch (error) {
            showProfileMessage(error.message, true);
        }
    });

    if (window.browser?.onProfileUpdated) {
        window.browser.onProfileUpdated(profile => {
            if (!profile) {
                if (activeProfile) applyProfile(null);
                return;
            }
            applyProfile(profile);
        });
    }

    updateProfileWidget();
    applyProfile(null);
    try {
        const response = await requestProfile('/me');
        if (response.profile) applyProfile(response.profile);
    } catch (error) {
        console.error('Could not load the Nexus profile.', error);
        showProfileMessage(`Profile service unavailable: ${error.message}`, true);
    }
}

function setMusicMessage(message, isError = false) {
    const label = document.getElementById('music-message');
    label.textContent = message;
    label.className = `min-h-4 text-[11px] ${isError ? 'text-rose-300' : 'text-slate-400'}`;
}

function makeMusicRow(track, options = {}) {
    const row = document.createElement('article');
    row.className = 'flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] p-2';

    if (track.artworkUrl) {
        const artwork = document.createElement('img');
        artwork.className = 'h-10 w-10 shrink-0 rounded-lg bg-white/5 object-cover';
        artwork.alt = '';
        artwork.loading = 'lazy';
        artwork.addEventListener('error', () => artwork.remove(), { once: true });
        artwork.src = track.artworkUrl;
        row.append(artwork);
    }

    const metadata = document.createElement('div');
    metadata.className = 'min-w-0 flex-1';
    const title = document.createElement('p');
    title.className = 'truncate font-semibold text-slate-200';
    title.textContent = track.title;
    const artist = document.createElement('p');
    artist.className = 'truncate text-[10px] text-slate-400';
    artist.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
    metadata.append(title, artist);
    row.append(metadata);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'shrink-0 rounded-lg border border-accent/40 bg-accent-soft px-2 py-1.5 text-[10px] font-semibold text-accent disabled:cursor-not-allowed disabled:opacity-40';
    play.textContent = 'Preview';
    play.disabled = !track.previewUrl;
    play.title = track.previewUrl ? 'Play official preview' : 'No preview is available for this track';
    play.addEventListener('click', () => playMusicTrack(track));
    row.append(play);

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-slate-300 hover:border-accent';
    select.textContent = 'Select';
    select.addEventListener('click', () => selectMusicTrack(track));
    row.append(select);

    if (options.allowAdd) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-slate-300 hover:border-accent';
        add.textContent = '+';
        add.setAttribute('aria-label', `Add ${track.title} to playlist`);
        add.addEventListener('click', () => addTrackToPlaylist(track));
        row.append(add);
    }

    if (options.playlistId) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-rose-300 hover:border-rose-300';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${track.title} from playlist`);
        remove.addEventListener('click', () => removeTrackFromPlaylist(options.playlistId, track.id));
        row.append(remove);
    }

    return row;
}

function renderTrackCollection(elementId, tracks, emptyMessage, options = {}) {
    const container = document.getElementById(elementId);
    container.replaceChildren();
    if (!tracks.length) {
        const empty = document.createElement('p');
        empty.className = 'px-2 py-3 text-center text-[11px] text-slate-500';
        empty.textContent = emptyMessage;
        container.append(empty);
        return;
    }
    for (const track of tracks) {
        container.append(makeMusicRow(track, options));
    }
}

function renderMusicLibrary() {
    const playlists = Array.isArray(profileData?.playlists) ? profileData.playlists : [];
    const playlistList = document.getElementById('music-playlists');
    const select = document.getElementById('music-playlist-target');
    if (!playlistList || !select) return;

    if (!playlists.some(playlist => playlist.id === selectedPlaylistId)) {
        selectedPlaylistId = playlists[0]?.id || null;
    }

    playlistList.replaceChildren();
    select.replaceChildren(new Option('Select a playlist', ''));
    for (const playlist of playlists) {
        const option = new Option(playlist.name, playlist.id);
        select.add(option);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `block w-full truncate rounded-lg px-2 py-1.5 text-left text-xs ${playlist.id === selectedPlaylistId ? 'bg-accent-soft text-accent' : 'text-slate-300 hover:bg-white/[0.06]'}`;
        button.textContent = `${playlist.name} · ${playlist.tracks.length}`;
        button.addEventListener('click', () => {
            selectedPlaylistId = playlist.id;
            renderMusicLibrary();
        });
        playlistList.append(button);
    }

    select.value = selectedPlaylistId || '';
    const selectedPlaylist = playlists.find(playlist => playlist.id === selectedPlaylistId);
    document.getElementById('music-playlist-title').textContent = selectedPlaylist?.name || 'Playlist tracks';
    document.getElementById('music-delete-playlist').disabled = !selectedPlaylist;
    document.getElementById('music-add-current').disabled = !selectedMusicTrack || !selectedPlaylist;
    renderTrackCollection(
        'music-playlist-tracks',
        selectedPlaylist?.tracks || [],
        selectedPlaylist ? 'This playlist is empty.' : 'Select or create a playlist.',
        { playlistId: selectedPlaylist?.id },
    );
    renderTrackCollection('music-recents', profileData.recentMusic || [], 'Your recent previews appear here.');
}

function selectMusicTrack(track) {
    selectedMusicTrack = track;
    const artwork = document.getElementById('music-artwork');
    if (track.artworkUrl) {
        artwork.src = track.artworkUrl;
        artwork.hidden = false;
        artwork.onerror = () => { artwork.hidden = true; };
    } else {
        artwork.removeAttribute('src');
        artwork.hidden = true;
    }
    document.getElementById('music-current-title').textContent = track.title;
    document.getElementById('music-current-artist').textContent = [track.artist, track.album].filter(Boolean).join(' · ');
    document.getElementById('music-open-lyrics').disabled = false;
    document.getElementById('music-open-track').disabled = !track.trackUrl;
    document.getElementById('music-add-current').disabled = !profileData.playlists.some(item => item.id === selectedPlaylistId);
    renderMusicLibrary();
}

function playMusicTrack(track) {
    if (!track?.previewUrl) {
        selectMusicTrack(track);
        setMusicMessage('This song does not have a preview. Open its full track page instead.', true);
        return;
    }
    selectMusicTrack(track);
    const audio = document.getElementById('music-audio');
    audio.pause();
    audio.src = track.previewUrl;
    audio.loop = document.getElementById('music-loop').checked;
    audio.load();
    profileData.recentMusic = [
        track,
        ...(profileData.recentMusic || []).filter(item => item.id !== track.id),
    ].slice(0, 50);
    persistProfileData();
    audio.play().then(() => setMusicMessage('Playing an official song preview.'))
        .catch(error => {
            console.error('Could not start the music preview.', error);
            setMusicMessage('Could not play this preview. Try another track.', true);
        });
}

function addTrackToPlaylist(track) {
    const playlist = profileData.playlists.find(item => item.id === selectedPlaylistId);
    if (!playlist) {
        setMusicMessage('Create or select a playlist before adding tracks.', true);
        return;
    }
    if (playlist.tracks.some(item => item.id === track.id)) {
        setMusicMessage('That track is already in this playlist.');
        return;
    }
    if (playlist.tracks.length >= 100) {
        setMusicMessage('A playlist can contain up to 100 tracks.', true);
        return;
    }
    playlist.tracks.push(track);
    persistProfileData();
    setMusicMessage(`Added ${track.title} to ${playlist.name}.`);
}

function removeTrackFromPlaylist(playlistId, trackId) {
    const playlist = profileData.playlists.find(item => item.id === playlistId);
    if (!playlist) return;
    playlist.tracks = playlist.tracks.filter(track => track.id !== trackId);
    persistProfileData();
}

function createMusicPlaylist(name) {
    const cleanName = name.trim().slice(0, 60);
    if (!cleanName) return;
    if (profileData.playlists.length >= 50) {
        setMusicMessage('You can create up to 50 playlists.', true);
        return;
    }
    const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    profileData.playlists.unshift({ id, name: cleanName, tracks: [] });
    selectedPlaylistId = id;
    persistProfileData();
    setMusicMessage(`Created playlist ${cleanName}.`);
}

function deleteSelectedPlaylist() {
    const playlist = profileData.playlists.find(item => item.id === selectedPlaylistId);
    if (!playlist) return;
    profileData.playlists = profileData.playlists.filter(item => item.id !== selectedPlaylistId);
    selectedPlaylistId = profileData.playlists[0]?.id || null;
    persistProfileData();
    setMusicMessage(`Deleted playlist ${playlist.name}.`);
}

async function searchMusic(event) {
    event.preventDefault();
    const query = document.getElementById('music-search-input').value.trim();
    if (!query) return;
    const submit = document.querySelector('#music-search-form button[type="submit"]');
    submit.disabled = true;
    setMusicMessage(`Searching for “${query}”…`);
    document.getElementById('music-results').textContent = 'Searching the music catalog…';
    recordRecentSearch(query);
    try {
        const tracks = await requestMusicSearch(query);
        renderTrackCollection('music-results', tracks, 'No songs matched that search.', { allowAdd: true });
        setMusicMessage(`${tracks.length} songs found. Previews are available where offered.`);
    } catch (error) {
        console.error('Music search failed.', error);
        document.getElementById('music-results').textContent = error.message;
        setMusicMessage(error.message, true);
    } finally {
        submit.disabled = false;
    }
}

function openMusicLyrics() {
    if (!selectedMusicTrack) return;
    const query = `${selectedMusicTrack.title} ${selectedMusicTrack.artist} lyrics`;
    spawnBrowserWindow(`https://genius.com/search?q=${encodeURIComponent(query)}`);
}

function openFullMusicTrack() {
    if (!selectedMusicTrack?.trackUrl) return;
    spawnBrowserWindow(selectedMusicTrack.trackUrl);
}

function initializeMusicPlayer() {
    document.getElementById('music-search-form').addEventListener('submit', searchMusic);
    document.getElementById('music-loop').addEventListener('change', event => {
        document.getElementById('music-audio').loop = event.target.checked;
    });
    document.getElementById('music-playlist-form').addEventListener('submit', event => {
        event.preventDefault();
        const field = document.getElementById('music-playlist-name');
        createMusicPlaylist(field.value);
        field.value = '';
    });
    document.getElementById('music-playlist-target').addEventListener('change', event => {
        selectedPlaylistId = event.target.value || null;
        renderMusicLibrary();
    });
    document.getElementById('music-add-current').addEventListener('click', () => {
        if (selectedMusicTrack) addTrackToPlaylist(selectedMusicTrack);
    });
    document.getElementById('music-delete-playlist').addEventListener('click', deleteSelectedPlaylist);
    document.getElementById('music-open-lyrics').addEventListener('click', openMusicLyrics);
    document.getElementById('music-open-track').addEventListener('click', openFullMusicTrack);
    document.getElementById('music-audio').addEventListener('error', () => {
        if (selectedMusicTrack) setMusicMessage('This preview could not be loaded. Try another result.', true);
    });
    renderMusicLibrary();
}

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeProfilePanel();
});

initializeMusicPlayer();
initializeProfile();
