-- 通知は朝6時（サマリー付き）の1回だけにする
select cron.unschedule('notify-evening');
