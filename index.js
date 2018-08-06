//Google認証情報
const KEYS = require("./privatekey.json");

//LINE認証情報
const LINE_KEYS = require("./line-secret.json");

//DynamoDB DocumentClient
const AWS = require("aws-sdk");
AWS.config.update({
    region: "ap-northeast-1"
});
const dynamodb = new AWS.DynamoDB.DocumentClient({
    apiVersion: "2012-08-10"
});
//AWS SNS
const SNS = new AWS.SNS({apiVersion: "2010-03-31"});

//GoogleAPI
const {google} = require("googleapis");

//JSON Web Tokens
const JWT = new google.auth.JWT({
    email: KEYS.client_email,
    key: KEYS.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"]
});

//GoogleCalendarAPI
const calendar = google.calendar("v3");

//tokenを記録しておくための連想配列にする。
const TOKENS = {};

//テーブル名
const TABLE_NAME = "table";

//LINE SDK
const LINE = require("@line/bot-sdk");
const LINE_CLIENT = new LINE.Client({
    channelAccessToken: LINE_KEYS.channelAccessToken,
    channelSecret: LINE_KEYS.channelSecret
});

//Botが属するグループのID
const GROUP_ID = "Ccf078887fcfe2814d0efc4699526061e";

//pageTokenにも対応できるイベント取得関数
//pageToken, events引数は再帰呼び出しの時に使うので、実際に使うときは指定しなくて良い。
//params = {auth, calendarId, syncToken, showDeleted}
//return: {nextSyncToken, events}
const getAllEventsList = (calendar, params, pageToken, events)=>{
    
    events = events || [];

    if(pageToken) params["pageToken"] = pageToken;

    return new Promise((resolve, reject)=>{
        calendar.events.list(params, (err, {data})=>{
            if(err) reject(err);
            else resolve(data);
        });
    })
    .then((data)=>{
        events = events.concat(data.items);
        if(data.nextPageToken){
            return getAllEventsList(calendar, params, data.nextPageToken, events);
        }
        if(data.nextSyncToken){
            return {nextSyncToken: data.nextSyncToken, events: events};
        }
    });

};

//ISO formatの日時の形式を整えて返す関数
//argument: date(UTC)
const prepareISOFomat = (date)=>{

    //0~6の整数と曜日を対応させるMapオブジェクト
    const numVsDay = new Map([
        [0, "(日)"],
        [1, "(月)"],
        [2, "(火)"],
        [3, "(水)"],
        [4, "(木)"],
        [5, "(金)"],
        [6, "(土)"]
    ]);
    
    //まずJSTに修正する
    date.setHours(date.getHours()+9);

    const YMD = date.getUTCFullYear() + "年" + (date.getUTCMonth()+1) + "月" + date.getUTCDate() + "日" + numVsDay.get(date.getUTCDay());
    //時刻の指定がない場合
    if(date.getHours() === 9 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0){
        return YMD;
    }
    //日時の指定がある場合
    const HMS = date.getUTCHours() + "時" + date.getUTCMinutes() + "分";
    return YMD + " " + HMS;
};

//LINE pushMEssageを作成する関数
//https://developers.google.com/calendar/v3/reference/events#resource
const createPushMessage = (item)=>{
    const status        = item.status;
    const authorEmail   = item.creator.email;
    const authorName    = item.creator.displayName;
    const summary       = item.summary;
    const description   = item.description;
    const createdTime   = new Date(item.created);
    const updatedTime   = new Date(item.updated);
    const link          = item.htmlLink;

    let text;

    //ステータス
    if(status === "cancelled"){
        text = "\u274C" + "[削除]";
    }else if(status === "confirmed"){
        const timeDelta = (updatedTime - createdTime) / 1000; //秒
        if(timeDelta <= 2){ //「更新」というステータスはないので、createdとupdatedの差が２秒以内なら新規とみなす。
            text = "\u2B50[新規]";
        }else{
            text = "\u2B55[更新]";
        }
    }else{ //tentative
        text = "\u2B50[仮]";
    }

    //予定の所有者
    text = text + " " + authorName + "(" + authorEmail + ")\n\n";
    
    //予定の概要
    text = text + "タイトル： " + summary + "\n\n";

    //予定の詳細（ない場合もある）
    if(description){
        text = text + "詳細: " + description + "\n\n";
    }

    //予定の開始と終了日時
    if(item.start.date && item.end.date){
        const startDate = new Date(item.start.date);
        const endDate   = new Date(item.end.date);
        if((endDate-startDate)/(1000*60*60*24) === 1){ //終日
            text = text + "予定日: " + prepareISOFomat(startDate) + " 終日\n\n";
        }else{
            text = text + "開始: " + prepareISOFomat(startDate) + "\n";
            text = text + "終了: " + prepareISOFomat(endDate) + "\n\n";
        }
    }else if(item.start.dateTime && item.end.dateTime){
        const startDatetime = new Date(item.start.dateTime);
        const endDatetime   = new Date(item.end.dateTime);
        text = text + "開始: " + prepareISOFomat(startDatetime) + "\n";
        text = text + "終了: " + prepareISOFomat(endDatetime) + "\n\n";
    }

    //カレンダーへのリンク
    text = text + "リンク: " + link;

    return text;

};

exports.handler = (event, context, callback) => {
    Promise.resolve()
    .then(()=>{
        console.log("--------認証処理start-----------");

        console.log("------------認証情報-------------");
        console.log(JWT);
        console.log("--------------------------------");

        //jwt.authorizeはPromiseをリターンしてくれる。
        //return JWT.authorize();
        return new Promise((resolve, reject)=>{
            JWT.authorize((err, resp)=>{
                if(err){
                    console.log("---------Authorize ERROR!----------");
                    console.log(JSON.stringify(err));
                    console.log("-----------------------------------");
                    reject(err);
                }else{
                    console.log("--------Authorize SUCCESS!------------");
                    console.log(JSON.stringify(resp));
                    console.log("--------------------------------------");
                    resolve();
                }
            });
        });
    })
    .then(()=>{
        console.log("--------Dynamoからトークンを取得---------");

        const dynamoGetParams = {
            TableName: TABLE_NAME,
            Key: {
                "client-email": KEYS.client_email
            }
        };
        console.log("----------dynamoGetParams--------------");
        console.log(JSON.stringify(dynamoGetParams));
        console.log("---------------------------------------");

        return new Promise((resolve, reject)=>{
            dynamodb.get(dynamoGetParams, (err, data)=>{    
                if(err){
                    console.log("----------------DynamoGet ERROR!---------------------");
                    console.log(JSON.stringify(err));
                    console.log("-----------------------------------------------------");
                    reject(err);
                }else{

                    console.log("--------------dynamodb Get Data-----------------");
                    console.log(JSON.stringify(data));
                    console.log("------------------------------------------------");
                    const item = data.Item;
                    //トークン情報を記録
                    for(let calendarId in item.tokens){
                        TOKENS[calendarId] = item.tokens[calendarId]
                    }
                    console.log("-----------TOKENS------------");
                    console.log(TOKENS);
                    console.log("-----------------------------");
                    resolve();
                };
            });
        });
        
    })
    .then(()=>{
        console.log("---------カレンダーリスト取得------------");

        return new Promise((resolve, reject)=>{
            calendar.calendarList.list({
                auth: JWT
            }, (err, {data})=>{
                if(err){
                    console.log("------------CalendarList Get ERROR!---------------");
                    console.log(JSON.stringify(err));
                    console.log("--------------------------------------------------");
                    reject(err);
                }else {
                    console.log("------------CalendarList Get-----------------");
                    console.log(data.items);
                    console.log("---------------------------------------------");
                    resolve(data.items);
                }
            });
        });
    })
    .then((calendarList)=>{
        console.log("--------それぞれのカレンダーのイベントリストを取得------------");

        //カレンダーリストの数だけ並列でPromiseを実行させる
        const promises = [];
        for(let i = 0; i < calendarList.length; i++){
            const getEventsParams = {
                auth: JWT,
                calendarId: calendarList[i].id,
                showDeleted: true
            };

            //DynamoにsyncTokenが記録されていた場合は、それを使う。
            if(TOKENS[calendarList[i].id]) getEventsParams["syncToken"] = TOKENS[calendarList[i].id];

            console.log("-----------GetEventsParams---------------");
            console.log(JSON.stringify(getEventsParams));
            console.log("-----------------------------------------");

            const promise = getAllEventsList(calendar, getEventsParams);
            promises.push(promise);
        }

        return Promise.all(promises).then((resp)=>{

            console.log("--------------Promise.allのreturn-----------------");
            console.log(resp);
            console.log("--------------------------------------------------");

            console.log("------Dynamoにトークン情報を記録--------");

            const updateTokenParams = {
                TableName: TABLE_NAME,
                Item: {
                    "client-email": KEYS.client_email,
                    "tokens": {}
                }
            };

            const events = {};
            for(let i = 0; i < resp.length; i++){
                updateTokenParams["Item"]["tokens"][calendarList[i].id] = resp[i].nextSyncToken;
                events[calendarList[i].id] = resp[i].events;
            }

            console.log("-----------------updateTokenParams--------------------");
            console.log(JSON.stringify(updateTokenParams));
            console.log("------------------------------------------------------");

            return new Promise((resolve, reject)=>{
                dynamodb.put(updateTokenParams, (err, data)=>{
                    if(err){
                        console.log("----------DynamoUpdate ERROR!------------");
                        console.log(JSON.stringify(err));
                        console.log("-----------------------------------------");
                        reject(err);
                    }else{
                        console.log("---------DynamoUpdate SUCCESS!----------");
                        resolve(events);
                    }
                });
            });
        });
    })
    .then((events)=>{
        console.log("-------------LINEへの通知--------------");
        /**
         * 
         * eventsオブジェクト
         * 
         * {
         *      calendarId: [
         *          予定たち    
         *      ],
         *      calendarId: [
         *          予定たち
         *      ]
         * }
         * 
         */

         //予定一つごとにpushMessageを送ることにする。
        const promises = [];
        for(let calendarId in events){
            const items = events[calendarId];
            //typeof(items) => array
            //if items.length == 0 , it means the claendarId's changed events don't exist.
            if(items.length == 0) continue;

            for(let i = 0; i < items.length; i++){
                const item = items[i];

                console.log("--------------pushMessage item---------------");
                console.log(item);
                console.log("---------------------------------------------");
                const params = {
                    type: "text"
                };

                params["text"] = createPushMessage(item);
                const promise = LINE_CLIENT.pushMessage(GROUP_ID, params);
                promises.push(promise);
            }
        }

        //promisesが空配列のままなら、以下の処理は必要なし。
        if(promises.length == 0){
            console.log("---------LINE通知する変更なし！-----------");
            return "LINE通知する変更なし！";
        }
        
        return Promise.all(promises).then((resp)=>{
            
            console.log("------------Promise.all(LINE pushMessage)-------------");
            console.log(JSON.stringify(resp));
            console.log("------------------------------------------------------");

            return events;
        });

    })
    .then((resp)=>{
        console.log("------成功！--------");
        callback(null, resp);
    })
    .catch((error)=>{
        console.log("------失敗！--------");
        //SNSでメール通知するようにしたい。

        const errorParams = {
            TopicArn: "xxxxxxxxxxxxxxxxxx",
            Subject: "カレンダー共有にエラー発生！",
            Message: "エラー概要は以下の通りです:\n\n" + JSON.stringify(error)
        };

        SNS.publish(errorParams, (err, data)=>{
            if(err){
                console.log("-------------SNS ERROR!----------------");
                console.log(JSON.stringify(err));
                console.log("---------------------------------------");
            }else{
                console.log("--------------SNS SUCCESS!----------------");
                console.log(JSON.stringify(data));
                console.log("------------------------------------------");
            }
        });

        callback(error);
    });
};

