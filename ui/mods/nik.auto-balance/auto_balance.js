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
    var playerRatings = {};       // uberId -> { rating, source, name }
    var balanceStatus = ko.observable('');
    var balanceStatusClass = ko.observable('');
    var isBalancing = ko.observable(false);
    var defaultRating = ko.observable(DEFAULT_RATING);
    var ratingExponent = ko.observable(DEFAULT_EXPONENT);

    // ── Rating Sources ─────────────────────────────────────────────────

    // Fetch HVI rating for a single player
    function fetchHVIRating(uberName) {
        return new Promise(function (resolve) {
            // First resolve the ubernet ID from display name
            api.net.ubernet(
                '/GameClient/UserId?' + $.param({ TitleDisplayName: uberName }),
                'GET', 'text'
            ).then(function (ubernetID) {
                var parsed = JSON.parse(ubernetID);
                var uberId = parsed.UberId;

                $.ajax({
                    url: HVI_URL + 'case=0&uberid=' + uberId + '&name=' + uberName,
                    dataType: 'json',
                    timeout: FETCH_TIMEOUT,
                    success: function (profile) {
                        if (profile && profile.name !== 'not registered' && profile.rating != null) {
                            resolve({
                                uberId: uberId,
                                rating: parseFloat(profile.rating),
                                source: 'HVI',
                                name: uberName
                            });
                        } else {
                            resolve({
                                uberId: uberId,
                                rating: null,
                                source: null,
                                name: uberName
                            });
                        }
                    },
                    error: function () {
                        resolve({
                            uberId: uberId,
                            rating: null,
                            source: null,
                            name: uberName
                        });
                    }
                });
            }).fail(function () {
                resolve({
                    uberId: null,
                    rating: null,
                    source: null,
                    name: uberName
                });
            });
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
    // Sorts players by power descending, assigns each to the group
    // with the lowest current total power.
    function partitionPlayers(players, numTeams) {
        // Compute power for each player
        players.forEach(function (p) {
            p.power = ratingToPower(p.rating);
        });

        // Sort by power descending
        players.sort(function (a, b) { return b.power - a.power; });

        var teams = [];
        for (var i = 0; i < numTeams; i++) {
            teams.push({ players: [], totalPower: 0, totalRating: 0 });
        }

        for (var p = 0; p < players.length; p++) {
            // Find team with lowest total power
            var minTeam = 0;
            var minPower = teams[0].totalPower;
            for (var t = 1; t < teams.length; t++) {
                if (teams[t].totalPower < minPower) {
                    minPower = teams[t].totalPower;
                    minTeam = t;
                }
            }
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

                // Cache the rating
                playerRatings[player.playerId] = {
                    rating: rating,
                    source: source,
                    name: player.name
                };
            }

            // Log ratings to chat
            model.localChatMessage('Auto-Balance', '── Player Ratings ──');
            ratedPlayers.forEach(function (p) {
                model.localChatMessage('Auto-Balance', p.name + ': ' + p.source);
            });

            // Partition into teams
            var teams = partitionPlayers(ratedPlayers, numTeams);

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

            // Execute the moves - assign players to their target armies
            var humanArmyIndices = [];
            var armies = model.armies();
            for (var a = 0; a < armies.length; a++) {
                if (!armies[a].aiArmy())
                    humanArmyIndices.push(a);
            }

            var moveDelay = 0;
            teams.forEach(function (team, teamIdx) {
                var targetArmy = humanArmyIndices[teamIdx];
                team.players.forEach(function (player) {
                    // Small delay between moves to avoid race conditions
                    setTimeout(function () {
                        model.send_message('move_player', {
                            player: player.playerId,
                            army: targetArmy
                        });
                    }, moveDelay);
                    moveDelay += 200;
                });
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
                '<button class="btn_std_gray auto-balance-btn" data-bind="click: autoBalance, disable: autoBalanceRunning()">' +
                    'Balance Teams' +
                '</button>' +
                '<button class="btn_std_gray auto-balance-btn small" data-bind="click: showPlayerRatings">' +
                    'Show Ratings' +
                '</button>' +
                '<div class="auto-balance-settings-row">' +
                    '<label>Def: <input type="number" step="0.5" min="0" max="10" data-bind="value: autoBalanceDefault" /></label>' +
                    '<label>Exp: <input type="number" step="0.1" min="0.1" max="3" data-bind="value: autoBalanceExponent" /></label>' +
                '</div>' +
                '<div class="auto-balance-status" data-bind="text: autoBalanceStatus, css: autoBalanceStatusClass"></div>' +
            '</div>' +
        '</div>';

    // Split the spectator panel: wrap existing spectator content in a left half,
    // add balance panel as a right half, using DOM moves (not clones) to
    // preserve knockout bindings on spectator elements.
    var $spectatorContainer = $('div.container-spectator');
    if ($spectatorContainer.length) {
        var $existingChildren = $spectatorContainer.children();

        // Create the flex wrapper and left half
        var $wrapper = $('<div class="spectator-balance-wrapper"></div>');
        var $leftHalf = $('<div class="spectator-half"></div>');

        // Move (not clone) existing spectator children into the left half
        $existingChildren.appendTo($leftHalf);

        $wrapper.append($leftHalf);
        $wrapper.append(balancePanelHTML);
        $spectatorContainer.append($wrapper);
    }

    console.log('Auto-Balance mod loaded');
})();
