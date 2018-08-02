var Topics = require.main.require('./src/topics');
var Posts = require.main.require('./src/posts');
var categories = require.main.require('./src/categories');
var plugins = require.main.require('./src/plugins');
var privileges = require.main.require('./src/privileges');
var User = require.main.require('./src/user');
var meta = require.main.require('./src/meta');
var db = require.main.require('./src/database');
var async = require.main.require('async');
var winston = require.main.require('winston');
var cronJob = require.main.require('cron').job;

(function(theme) {
  theme.init = function(params, callback) {
    var cronString = '05,35 * * * *';
    function doAllTopics () {
			winston.verbose('[recent-sorted] job of compute topic scores started.');
			db.getSortedSetRevRange('topics:recent', 0, -1, function(err, tids){
        if (err) return winston.error(err);
        async.each(tids, function(tid) {
          async.series([
            async.apply(computeTopicKarmaOfCreated, tid),
            async.apply(computeTopicScoreWithTid, tid),
          ]);
        });
      });
		}
    cronJob(cronString, doAllTopics, null, true);
    winston.verbose(`[recent-sorted] create cron job of compute topic scores: ${cronString}`);
    doAllTopics();
    callback();
  };

  Topics.getRecentTopics = function (cid, uid, start, stop, filter, callback) {
		var recentTopics = {
			nextStart: 0,
			topics: [],
		};
		if (cid && !Array.isArray(cid)) {
			cid = [cid];
		}
		async.waterfall([
			function (next) {
				var key = 'topics:recent-sorted';
				if (cid) {
					key = cid.map(function (cid) {
						return 'cid:' + cid + ':tids:lastposttime';
					});
				}
				db.getSortedSetRevRange(key, 0, 399, next);
			},
			function (tids, next) {
				filterTids(tids, uid, filter, cid, next);
			},
			function (tids, next) {
				recentTopics.topicCount = tids.length;
				tids = tids.slice(start, stop + 1);
				Topics.getTopicsByTids(tids, uid, next);
			},
			function (topicData, next) {
				recentTopics.topics = topicData;
				recentTopics.nextStart = stop + 1;
				next(null, recentTopics);
			},
		], callback);
	};

	function filterTids(tids, uid, filter, cid, callback) {
		async.waterfall([
			function (next) {
				if (filter === 'watched') {
					Topics.filterWatchedTids(tids, uid, next);
				} else if (filter === 'new') {
					Topics.filterNewTids(tids, uid, next);
				} else if (filter === 'unreplied') {
					Topics.filterUnrepliedTids(tids, next);
				} else {
					Topics.filterNotIgnoredTids(tids, uid, next);
				}
			},
			function (tids, next) {
				privileges.topics.filterTids('read', tids, uid, next);
			},
			function (tids, next) {
				async.parallel({
					ignoredCids: function (next) {
						if (filter === 'watched' || parseInt(meta.config.disableRecentCategoryFilter, 10) === 1) {
							return next(null, []);
						}
						User.getIgnoredCategories(uid, next);
					},
					topicData: function (next) {
						Topics.getTopicsFields(tids, ['tid', 'cid'], next);
					},
				}, next);
			},
			function (results, next) {
				cid = cid && cid.map(String);
				tids = results.topicData.filter(function (topic) {
					if (topic && topic.cid) {
						return results.ignoredCids.indexOf(topic.cid.toString()) === -1 && (!cid || (cid.length && cid.indexOf(topic.cid.toString()) !== -1));
					}
					return false;
				}).map(function (topic) {
					return topic.tid;
				});
				next(null, tids);
			},
		], callback);
	}

	function computeTopicScore(topic, callback) {
		var sView = Math.log10(topic.viewcount || 1)*5;
		var sPost = topic.postcount / 2;
    var sUpvote = topic.upvotes || 0;
    var sDownvote = topic.downvotes || 0;

		var sVotes = sUpvote - sDownvote + Math.log2((sUpvote + sDownvote) || 1);
    var sHours = Math.floor((Date.now() - topic.timestamp) / 3600000);
    var sLastPostHours = Math.ceil((Date.now() - topic.lastposttime) / 3600000) || 1;
		var sKarma = topic.sKarma || 0;
		var sTotal = 10 + sView + sPost + sVotes + sKarma;

    // winston.verbose(`${sView} ${sPost} ${sUpvote} ${sDownvote} ${sVotes} ${sHours} ${sKarma} ${sTotal}`);
		topic.sScore = sTotal / Math.pow((sHours+ 10 + sLastPostHours) / 2, 1.4);
    // winston.verbose(`[recent-sorted] topic(${topic.tid}) sScore: ${topic.sScore}`)

		async.parallel([
			async.apply(db.sortedSetAdd, 'topics:recent-sorted', topic.sScore, topic.tid),
			async.apply(Topics.setTopicField, topic.tid, 'sScore', topic.sScore)
		], callback);
	}

  function computeTopicScoreWithTid(tid, callback) {
    async.waterfall([
      function(next) {
        db.getObject('topic:'+tid, next);
      },
      function(topic, next) {
        if (topic && topic.tid) {
          computeTopicScore(topic, next);
        } else {
          next();
        }
      }
    ], callback);
  }

  function computeTopicKarmaOfCreated(topicData, callback) {
    var topic = topicData;

    async.waterfall([
      function(next) {
        if (typeof topic === 'number' || typeof topic === 'string') {
          db.getObject('topic:'+topic, function(err, data) {
            topic = data;
            next(err);
          });
        } else {
          next();
        }
      },
      function(next) {
        db.getObject('user:'+topic.uid, next);
      },
			function (user, next) {   // calculate sKarma;
				if (!user) return next();

				if (!topic.sKarma) topic.sKarma = 0;

        // if user has negative reputation...
        topic.sKarma = user.reputation * 0.1 / 2;
        // winston.verbose(`[recent-sorted] topic(${topic.tid}) by user(${topic.uid}), sKarma(${topic.sKarma})`);

				Topics.setTopicField(topic.tid, 'sKarma', topic.sKarma, next);
			}
    ], callback);
  }

	Topics.increaseViewCount = async.compose(Topics.increaseViewCount, function(tid, callback) {
		async.waterfall([
      function(next) {
        db.getObject('topic:'+tid, next);
      },
      function(topic, next) {
				topic.viewcount += 1;
				winston.verbose(`[recent-sorted] compute topic score: viewcount ${topic.viewcount}`);
				computeTopicScore(topic, next);
			}
		], function(err) {
			callback(err, tid);
		});
	});

	function handleTopicOnVote(uid, hook, current, topic) {
		if (!uid) return; // not login

		async.waterfall([
			async.apply(db.getObject, 'user:'+uid),
			function (user, next) {   // calculate sKarma;
				if (user.reputation <= 0) return next();
				if (!topic.sKarma) topic.sKarma = 0;

				var sKarma = user.reputation * 0.1;

				if (hook === 'unvote') {
					if (current === 'upvote') {
						topic.sKarma -= sKarma;
						winston.verbose(`[recent-sorted] unvote upvoted tid:${topic.tid}, sKarma: -${sKarma}`);
					} else {
						topic.sKarma += sKarma;
						winston.verbose(`[recent-sorted] unvote downvoted tid:${topic.tid}, sKarma: +${sKarma}`);
					}
				} else {
					if (current === 'upvote') {
						// user has upvoted, clicks downvote;
						topic.sKarma -= 2*sKarma;
						winston.verbose(`[recent-sorted] upvote -> downvote tid:${topic.tid}, sKarma: -${sKarma} * 2`);
					} else if (current === 'downvote') {
						// user has downvoted, clicks upvote;
						topic.sKarma += 2*sKarma;
						winston.verbose(`[recent-sorted] downvote -> upvote tid:${topic.tid}, sKarma: +${sKarma} * 2`);
					} else if (hook === 'upvote'){
						winston.verbose(`[recent-sorted] upvote tid:${topic.tid}, sKarma: +${sKarma}`);
						topic.sKarma += sKarma;
					} else {
						winston.verbose(`[recent-sorted] downvote tid:${topic.tid}, sKarma: -${sKarma}`);
						topic.sKarma -= sKarma;
					}
				}
				Topics.setTopicField(topic.tid, 'sKarma', topic.sKarma, next);
			},
			function(next) {  // calculate votes;
				if (hook === 'unvote') {
					if (current === 'upvote') {
						topic.upvotes -= 1;
					} else {
						topic.downvotes -= 1;
					}
				} else {
					if (current === 'upvote') {
						// user has upvoted, clicks downvote;
						topic.upvotes -= 1;
						topic.downvotes += 1;
					} else if (current === 'downvote') {
						// user has downvoted, clicks upvote;
						topic.downvotes -= 1;
						topic.upvotes += 1;
					} else if (hook === 'upvote'){
						topic.upvotes += 1;
					} else {
						topic.downvotes += 1;
					}
				}
				computeTopicScore(topic, next);
			}
		]);
	}

	function funcOnVote(hook, data) {
		Topics.getTopicDataByPid(data.pid, function(err, topic) {
			if (err) return winston.error(err);

			if (topic.mainPid == data.pid) {
				handleTopicOnVote(data.uid, hook, data.current, topic);
			} else {
				winston.verbose(`[recent-sorted] upvote/downvote on post(${data.pid}) but not mainPost(${topic.mainPid})`);
			}
		});
	};

	theme.onUpvote = funcOnVote.bind(theme, 'upvote');
	theme.onUnvote = funcOnVote.bind(theme, 'unvote');
	theme.onDownvote = funcOnVote.bind(theme, 'downvote');

  theme.onSaveTopic = function(data) {
    async.waterfall([
      async.apply(computeTopicKarmaOfCreated, data.topic),
      async.apply(computeTopicScore, data.topic)
    ], function(err) {
      if (err) return winston.error(err);
      winston.verbose(`[recent-sorted] create topic(${data.topic.tid}) by user(${data.topic.uid}), sKarma(${data.topic.sKarma})`);
    });
  };
  theme.onPurgeTopic = function(data) {
    winston.verbose(`[recent-sorted] purge topic ${data.topic.tid}`);
    db.sortedSetRemove('topics:recent-sorted', data.topic.tid);
  };
  theme.onSavePost = function(data) {
    if (!data.post.isMain) {
      winston.verbose(`[recent-sorted] add post reply ${data.post.pid} to topic ${data.post.tid}`);
      computeTopicScoreWithTid(data.post.tid);
    }
  };
  theme.onPurgePost = function(data) {
    winston.verbose(`[recent-sorted] purge post ${data.post.pid} of topic ${data.post.tid}`);
    computeTopicScoreWithTid(data.post.tid);
  };
  theme.onDeletePost = function(data) {
    winston.verbose(`[recent-sorted] delete post ${data.post.pid} of topic ${data.post.tid}`);
    computeTopicScoreWithTid(data.post.tid);
  };
})(exports);
