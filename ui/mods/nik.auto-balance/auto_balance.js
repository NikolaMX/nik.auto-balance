// Auto Balance Mod - Balances lobby teams by player skill rating
// Author: NikolaMX
// Uses HVI ratings (primary) with configurable default for unrated players

(function () {
    // Guard against double execution (community mods manager + direct mount)
    if (model._autoBalanceLoaded) return;
    model._autoBalanceLoaded = true;

    // ── Configuration ──────────────────────────────────────────────────
    var HVI_URL = 'http://nuttygroup.org:27395/?';
    var DEFAULT_RATING = 2.0;     // default for players with no rating anywhere
    var FETCH_TIMEOUT = 5000;     // ms to wait for rating lookups
    var DEFAULT_EXPONENT = 0.7;   // rating^exponent for team power calculation
                                  // In PA team games, more players > fewer stronger ones
                                  // (3x rated-6 beats 2x rated-9 due to map control/eco)
                                  // < 1.0 = diminishing returns for high skill (quantity wins)
                                  // 1.0 = linear
                                  // > 1.0 = skill dominates (solo carry)

    // ── State ──────────────────────────────────────────────────────────
    var balanceStatus = ko.observable('');
    var balanceStatusClass = ko.observable('');
    var isBalancing = ko.observable(false);
    var defaultRating = ko.observable(DEFAULT_RATING);
    var ratingExponent = ko.observable(DEFAULT_EXPONENT);

    // ── Rating Sources ─────────────────────────────────────────────────

    var NULL_RATING = { uberId: null, rating: null, source: null };

    // Fetch HVI rating for a single player. Always resolves, never rejects.
    function fetchHVIRating(uberName) {
        return new Promise(function (resolve) {
            api.net.ubernet(
                '/GameClient/UserId?' + $.param({ TitleDisplayName: uberName }),
                'GET', 'text'
            ).then(function (ubernetID) {
                var uberId;
                try {
                    uberId = JSON.parse(ubernetID).UberId;
                } catch (e) {
                    resolve(NULL_RATING);
                    return;
                }

                if (!uberId) { resolve(NULL_RATING); return; }

                $.ajax({
                    url: HVI_URL + 'case=0&uberid=' + uberId + '&name=' + encodeURIComponent(uberName),
                    dataType: 'json',
                    timeout: FETCH_TIMEOUT,
                    success: function (profile) {
                        if (profile && profile.name !== 'not registered' && profile.rating != null) {
                            resolve({ uberId: uberId, rating: parseFloat(profile.rating), source: 'HVI' });
                        } else {
                            resolve(NULL_RATING);
                        }
                    },
                    error: function () { resolve(NULL_RATING); }
                });
            }).fail(function () { resolve(NULL_RATING); });
        });
    }

    // ── Collect all human players from the lobby ───────────────────────

    function getHumanPlayers() {
        var players = [];
        var armies = model.armies();
        for (var a = 0; a < armies.length; a++) {
            var army = armies[a];
            if (army.aiArmy())
                continue;
            var slots = army.slots();
            for (var s = 0; s < slots.length; s++) {
                var slot = slots[s];
                if (!slot.isEmpty() && !slot.ai() && slot.playerName()) {
                    players.push({
                        name: slot.playerName(),
                        playerId: slot.playerId(),
                        armyIndex: slot.armyIndex()
                    });
                }
            }
        }
        return players;
    }

    // ── Get number of non-AI armies ────────────────────────────────────

    function getHumanArmyCount() {
        var count = 0;
        var armies = model.armies();
        for (var a = 0; a < armies.length; a++) {
            if (!armies[a].aiArmy())
                count++;
        }
        return count;
    }

    // ── Balancing Algorithm ────────────────────────────────────────────

    // Convert a display rating (0-10) to a "power" value for balancing.
    // Skill in RTS compounds non-linearly: a 9-rated player is NOT worth
    // two 4.5s or three 3s. The exponent controls how steep the curve is.
    function ratingToPower(rating) {
        var exp = parseFloat(ratingExponent()) || DEFAULT_EXPONENT;
        return Math.pow(Math.max(rating, 0), exp);
    }

    // Greedy number partitioning into K groups using power values.
    // Sorts players by power descending, assigns each to the group with the
    // lowest current total power that still has a free slot.
    //
    // capacities[i] is the number of slots team i (army i) can hold. Honouring
    // it is what keeps us from ever assigning more players to an army than it
    // has room for — overfilling an army is what makes the server bounce a
    // moved player into a spectator slot (see doBalance scheduling below).
    function partitionPlayers(players, capacities) {
        // Compute power for each player
        players.forEach(function (p) {
            p.power = ratingToPower(p.rating);
        });

        // Sort by power descending
        players.sort(function (a, b) { return b.power - a.power; });

        var teams = capacities.map(function (cap) {
            return { players: [], totalPower: 0, totalRating: 0, capacity: cap };
        });

        for (var p = 0; p < players.length; p++) {
            // Find the team with a free slot and the lowest total power
            var minTeam = -1;
            var minPower = Infinity;
            for (var t = 0; t < teams.length; t++) {
                if (teams[t].players.length >= teams[t].capacity)
                    continue;
                if (teams[t].totalPower < minPower) {
                    minPower = teams[t].totalPower;
                    minTeam = t;
                }
            }
            if (minTeam === -1)
                break; // no capacity left anywhere (only if players > total slots)
            teams[minTeam].players.push(players[p]);
            teams[minTeam].totalPower += players[p].power;
            teams[minTeam].totalRating += players[p].rating;
        }

        return teams;
    }

    // ── Execute Balance ────────────────────────────────────────────────

    function doBalance() {
        if (!model.isGameCreator()) {
            setStatus('Only the game creator can auto-balance', 'error');
            return;
        }

        if (!model.isTeamGame()) {
            setStatus('Auto-balance only works in Team Armies mode', 'error');
            return;
        }

        var humanPlayers = getHumanPlayers();
        var numTeams = getHumanArmyCount();

        if (humanPlayers.length < 2) {
            setStatus('Need at least 2 players to balance', 'error');
            return;
        }

        if (numTeams < 2) {
            setStatus('Need at least 2 teams to balance', 'error');
            return;
        }

        isBalancing(true);
        setStatus('Fetching ratings...', '');

        // Fetch ratings for all players
        var fetchPromises = humanPlayers.map(function (p) {
            return fetchHVIRating(p.name);
        });

        Promise.all(fetchPromises).then(function (results) {
            var ratedPlayers = [];
            var unratedNames = [];
            var defRating = parseFloat(defaultRating()) || DEFAULT_RATING;

            for (var i = 0; i < humanPlayers.length; i++) {
                var player = humanPlayers[i];
                var result = results[i];
                var rating = defRating;
                var source = 'default (' + defRating.toFixed(1) + ')';

                if (result.rating != null) {
                    rating = result.rating;
                    source = result.source + ' (' + rating.toFixed(1) + ')';
                } else {
                    unratedNames.push(player.name);
                }

                ratedPlayers.push({
                    name: player.name,
                    playerId: player.playerId,
                    rating: rating,
                    source: source
                });
            }

            // Log ratings to chat
            model.localChatMessage('Auto-Balance', '── Player Ratings ──');
            ratedPlayers.forEach(function (p) {
                model.localChatMessage('Auto-Balance', p.name + ': ' + p.source);
            });

            // Re-snapshot lobby after the fetch (players may have joined/left).
            var currentPlayers = getHumanPlayers();
            var currentArmyOf = {};   // playerId -> current armyIndex
            currentPlayers.forEach(function (p) { if (p.playerId) currentArmyOf[p.playerId] = p.armyIndex; });

            // Use army.index() (the game's army ID), not the array position, and
            // record each army's slot capacity so we never over-assign.
            var humanArmyIndices = [];
            var armyCapacity = {};     // armyIndex -> total slots
            var armies = model.armies();
            for (var a = 0; a < armies.length; a++) {
                if (armies[a].aiArmy()) continue;
                var aIdx = armies[a].index();
                humanArmyIndices.push(aIdx);
                armyCapacity[aIdx] = armies[a].slots().length;
            }

            // Only balance players that are still present in the lobby.
            var balancePlayers = ratedPlayers.filter(function (p) {
                return p.playerId && (p.playerId in currentArmyOf);
            });

            // Partition into teams, capping each team at its army's slot count so
            // the assignment can always be realised without overfilling an army.
            var capacities = humanArmyIndices.map(function (idx) { return armyCapacity[idx]; });
            var teams = partitionPlayers(balancePlayers, capacities);

            // Log team assignments
            model.localChatMessage('Auto-Balance', '── Team Assignments ──');
            teams.forEach(function (team, idx) {
                var names = team.players.map(function (p) { return p.name + ' [' + p.rating.toFixed(1) + ']'; }).join(', ');
                model.localChatMessage('Auto-Balance',
                    'Team ' + (idx + 1) + ' (power: ' + team.totalPower.toFixed(1) + '): ' + names);
            });

            // Calculate balance quality (based on power, not raw rating)
            var maxTotal = Math.max.apply(null, teams.map(function (t) { return t.totalPower; }));
            var minTotal = Math.min.apply(null, teams.map(function (t) { return t.totalPower; }));
            var diff = maxTotal - minTotal;

            // Build the target mapping: playerId -> target armyIndex
            var targetArmyOf = {};
            teams.forEach(function (team, teamIdx) {
                var targetArmy = humanArmyIndices[teamIdx];
                if (targetArmy === undefined) return;
                team.players.forEach(function (player) {
                    targetArmyOf[player.playerId] = targetArmy;
                });
            });

            // ── Realise the assignment safely ──────────────────────────────
            // The server's move_player removes a player from their army FIRST
            // and only then tries to add them to the target. If the target is
            // full at that instant the add fails and the player is left army-less
            // — i.e. dumped into a spectator slot. To avoid that we simulate the
            // lobby's live slot counts and only ever:
            //   • move a player into an army that currently has a free slot, or
            //   • swap with someone in a full target army who doesn't belong there
            //     (a swap exchanges slots and can never overfill).
            var liveArmyOf = {};
            var liveCount = {};
            humanArmyIndices.forEach(function (idx) { liveCount[idx] = 0; });
            balancePlayers.forEach(function (p) {
                var army = currentArmyOf[p.playerId];
                liveArmyOf[p.playerId] = army;
                liveCount[army] = (liveCount[army] || 0) + 1;
            });

            var pids = balancePlayers.map(function (p) { return p.playerId; });

            function firstMisplaced() {
                for (var i = 0; i < pids.length; i++) {
                    if (liveArmyOf[pids[i]] !== targetArmyOf[pids[i]])
                        return pids[i];
                }
                return null;
            }

            var ops = [];   // { swap:[a,b] } or { move:pid, army:to }
            var guard = 0;
            var pid;
            while ((pid = firstMisplaced()) !== null && guard++ < 1000) {
                var from = liveArmyOf[pid];
                var to = targetArmyOf[pid];

                if (liveCount[to] < armyCapacity[to]) {
                    // Target has room: a plain move is safe.
                    ops.push({ move: pid, army: to });
                    liveCount[from]--;
                    liveCount[to]++;
                    liveArmyOf[pid] = to;
                } else {
                    // Target is full: swap with an occupant who belongs elsewhere.
                    var partner = null;
                    for (var i = 0; i < pids.length; i++) {
                        var q = pids[i];
                        if (q !== pid && liveArmyOf[q] === to && targetArmyOf[q] !== to) {
                            partner = q;
                            break;
                        }
                    }
                    if (partner === null) break; // counts inconsistent; bail rather than risk a spec-kick
                    ops.push({ swap: [pid, partner] });
                    liveArmyOf[pid] = to;
                    liveArmyOf[partner] = from;
                    // a swap leaves liveCount unchanged
                }
            }

            // Fire the operations in order, staggered so the server applies them
            // sequentially against the slot state we simulated above.
            var moveDelay = 0;
            ops.forEach(function (op) {
                setTimeout((function (o) {
                    return function () {
                        if (o.swap)
                            model.send_message('swap_players', { player1: o.swap[0], player2: o.swap[1] });
                        else
                            model.send_message('move_player', { player: o.move, army: o.army });
                    };
                }(op)), moveDelay);
                moveDelay += 200;
            });

            // Show result after all moves complete
            setTimeout(function () {
                isBalancing(false);
                if (unratedNames.length > 0) {
                    setStatus('Balanced (diff: ' + diff.toFixed(1) + '). Unrated: ' + unratedNames.join(', '), 'success');
                } else {
                    setStatus('Balanced! Team diff: ' + diff.toFixed(1), 'success');
                }
            }, moveDelay + 100);
        }).catch(function (err) {
            isBalancing(false);
            setStatus('Error: ' + (err.message || err), 'error');
            console.error('Auto-Balance error:', err);
        });
    }

    // ── Show Ratings (without balancing) ───────────────────────────────

    function showRatings() {
        var humanPlayers = getHumanPlayers();
        if (humanPlayers.length === 0) {
            setStatus('No players in lobby', 'error');
            return;
        }

        setStatus('Fetching ratings...', '');

        var fetchPromises = humanPlayers.map(function (p) {
            return fetchHVIRating(p.name);
        });

        Promise.all(fetchPromises).then(function (results) {
            var defRating = parseFloat(defaultRating()) || DEFAULT_RATING;
            model.localChatMessage('Auto-Balance', '── Player Ratings ──');
            for (var i = 0; i < humanPlayers.length; i++) {
                var player = humanPlayers[i];
                var result = results[i];
                var rating = defRating;
                var source = 'default';

                if (result.rating != null) {
                    rating = result.rating;
                    source = result.source;
                }

                model.localChatMessage('Auto-Balance',
                    player.name + ': ' + rating.toFixed(1) + ' (' + source + ')');
            }
            setStatus('Ratings shown in chat', 'success');
        }).catch(function (err) {
            setStatus('Error fetching ratings', 'error');
        });
    }

    // ── UI Helpers ─────────────────────────────────────────────────────

    function setStatus(msg, cssClass) {
        balanceStatus(msg);
        balanceStatusClass(cssClass || '');
    }

    // ── Inject UI ──────────────────────────────────────────────────────

    // Bind our functions and observables to the model
    model.autoBalance = doBalance;
    model.showPlayerRatings = showRatings;
    model.autoBalanceRunning = isBalancing;
    model.autoBalanceStatus = balanceStatus;
    model.autoBalanceStatusClass = balanceStatusClass;
    model.autoBalanceDefault = defaultRating;
    model.autoBalanceExponent = ratingExponent;

    // The balance panel HTML (right half of the spectator row)
    var balancePanelHTML =
        '<div class="balance-half" data-bind="visible: isGameCreator() && isTeamGame()">' +
            '<div class="balance-panel-header">AUTO-BALANCE</div>' +
            '<div class="balance-panel">' +
                '<div class="btn_std_gray auto-balance-btn" data-bind="click: autoBalance, css: { btn_std_gray_disabled: autoBalanceRunning() }">' +
                    '<div class="btn_std_label">Balance Teams</div>' +
                '</div>' +
                '<div class="btn_std_gray auto-balance-btn small" data-bind="click: showPlayerRatings">' +
                    '<div class="btn_std_label">Show Ratings</div>' +
                '</div>' +
                '<div class="auto-balance-settings-row">' +
                    '<label>Def: <input type="number" step="0.5" min="0" max="10" data-bind="value: autoBalanceDefault" /></label>' +
                    '<label>Exp: <input type="number" step="0.1" min="0.1" max="3" data-bind="value: autoBalanceExponent" /></label>' +
                '</div>' +
                '<div class="auto-balance-status" data-bind="text: autoBalanceStatus, css: autoBalanceStatusClass"></div>' +
            '</div>' +
        '</div>';

    // Inject into td.spectators, which always exists in the DOM (unlike
    // div.container-spectator which is inside a ko if: showSpectators block
    // and may not exist when spectator limit is 0).
    // We wrap the td's existing children (the ko-if block) in the left half,
    // and append our balance panel as the right half.
    var $spectatorsTd = $('td.spectators');
    if ($spectatorsTd.length) {
        var $existingChildren = $spectatorsTd.children();

        var $wrapper = $('<div class="spectator-balance-wrapper"></div>');
        var $leftHalf = $('<div class="spectator-half"></div>');

        // Move existing children (the ko if: showSpectators block) into left half
        $existingChildren.appendTo($leftHalf);

        $wrapper.append($leftHalf);
        $wrapper.append(balancePanelHTML);
        $spectatorsTd.append($wrapper);
    }

    console.log('Auto-Balance mod loaded');
})();
